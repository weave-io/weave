## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/adapters/opencode/src/index.ts` | Main `OpenCodeAdapter` entry point; constructor, `init()`, `loadAvailableSkills()`, and `spawnSubagent()` will change here. |
| `packages/adapters/opencode/src/translate-agent.ts` | Current descriptor-to-OpenCode translation logic; needs resolved-model and ownership metadata support. |
| `packages/adapters/opencode/src/sdk-types.ts` | Sole adapter-owned SDK import surface; may need additional SDK type re-exports for list/upsert behavior. |
| `packages/adapters/opencode/src/tool-policy-mapping.ts` | Existing concrete permission mapping that the materialized agent payload must keep using. |
| `packages/adapters/opencode/src/run-workflow.ts` | Existing workflow helper; should remain within first-slice non-goals except for compatibility checks. |
| `packages/adapters/opencode/src/opencode-client.ts` | New adapter-local facade for listing, creating, and updating OpenCode agents through the injected SDK client. |
| `packages/adapters/opencode/src/reconcile-agent.ts` | New adapter-local reconciliation logic for upsert-only ownership-safe behavior. |
| `packages/adapters/opencode/src/model-resolution.ts` | New adapter-local model-context helper that wraps `resolveAdapterModelIntent()` with OpenCode discovery inputs. |
| `packages/adapters/opencode/src/skill-discovery.ts` | New adapter-local skill discovery module returning `SkillInfo[]` for engine resolution. |
| `packages/adapters/opencode/src/__tests__/adapter.test.ts` | New adapter tests for injected client setup, materialization, and collision behavior. |
| `packages/adapters/opencode/src/__tests__/translate-agent.test.ts` | New unit tests for translation behavior, prompt mapping, and presentation-field handling. |
| `packages/adapters/opencode/src/__tests__/model-resolution.test.ts` | New unit tests for selected/default/available-model resolution behavior. |
| `packages/adapters/opencode/src/__tests__/skill-discovery.test.ts` | New unit tests for skill discovery and missing-skill failure behavior. |
| `packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts` | New unit tests for create, update, and foreign-agent collision behavior. |
| `docs/adapter-readiness-status.md` | Must be updated so OpenCode adapter status reflects the first real materialization slice. |
| `docs/adapter-boundary.md` | Must stay aligned with adapter-owned discovery/reconciliation boundaries and any clarified ownership-marker assumption. |
| `docs/specs/20-spec-opencode-adapter-materialization/20-spec-opencode-adapter-materialization.md` | Source spec for this work; may need clarification if audit remediation is approved. |
| `docs/adr/0003-opencode-adapter-materialization-shape.md` | New ADR for SDK-first, plugin/runtime-first, ownership-safe adapter design. |

### Notes

- Use Bun test files colocated under `packages/adapters/opencode/src/__tests__/` and keep them isolated with mocked clients rather than a live OpenCode runtime.
- Preserve the first-slice non-goals: no workflow-lifecycle expansion, no prune/delete reconciliation, and no engine API drift unless separately approved.
- For manual smoke validation, use OpenCode with only `@weave/adapter-opencode` loaded because the user’s normal configuration still contains the legacy weave plugin.
- Use workspace quality gates from the repo: `bun run typecheck`, `bun run build`, and targeted Bun adapter tests before relying on smoke evidence.

## Tasks

### [x] 1.0 Establish the injected OpenCode client path and adapter-owned SDK facade

#### 1.0 Proof Artifact(s)

- Diff: `packages/adapters/opencode/src/index.ts` shows injected client/facade constructor options and no hidden global SDK state demonstrates dependency injection is the primary adapter entry path.
- Diff: `packages/adapters/opencode/src/opencode-client.ts` defines the narrow adapter-local list/create/update facade demonstrates SDK surface isolation.
- Test: `bun test packages/adapters/opencode/src/__tests__/adapter.test.ts` passes with mocked client construction coverage demonstrates the adapter can initialize with injected dependencies.
- Proof: `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-01-proofs.md`

#### 1.0 Tasks

- [x] 1.1 Add explicit adapter constructor options for an injected OpenCode SDK client or narrow adapter-owned facade in `packages/adapters/opencode/src/index.ts`.
- [x] 1.2 Create `packages/adapters/opencode/src/opencode-client.ts` with a minimal interface for listing agents, creating agents, and updating agents without exposing raw SDK calls throughout the adapter.
- [x] 1.3 Keep `packages/adapters/opencode/src/sdk-types.ts` as the only direct SDK import surface and add any missing type re-exports needed by the facade.
- [x] 1.4 Update adapter initialization code so `OpenCodeAdapter` stores the injected dependency without relying on global mutable state.
- [x] 1.5 Add `packages/adapters/opencode/src/__tests__/adapter.test.ts` coverage proving the adapter can be constructed and initialized with a mocked injected client.

### [x] 2.0 Replace in-memory translation with real SDK-backed materialization

#### 2.0 Proof Artifact(s)

- Test: `bun test packages/adapters/opencode/src/__tests__/adapter.test.ts` passes with create/update materialization cases demonstrates `spawnSubagent(descriptor)` uses the SDK-backed path.
- CLI: a sanitized smoke command recorded in validation notes (running OpenCode with only `@weave/adapter-opencode` enabled) produces an agent list or UI-visible agent entry for a Weave-authored agent demonstrates runtime materialization.
- Diff: `packages/adapters/opencode/src/index.ts` removes the comment that real registration is deferred demonstrates the first-slice path is no longer in-memory only.
- Proof: `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-02-proofs.md`
- Smoke: `docs/specs/20-spec-opencode-adapter-materialization/20-smoke-checklist-task-02.md`

#### 2.0 Tasks

- [x] 2.1 Refactor `spawnSubagent(descriptor)` so translation is followed by SDK-backed materialization rather than only `translatedAgents.set(...)`.
- [x] 2.2 Decide and document the exact adapter-local flow for `list existing → reconcile decision → create/update call` inside the new facade/reconciliation modules.
- [x] 2.3 Preserve `translatedAgents` only if still needed for test visibility or transitional compatibility; otherwise remove or narrow it so the real SDK path is the primary behavior.
- [x] 2.4 Add mocked-client adapter tests proving a successful create path and a successful update path both invoke the expected facade methods.
- [x] 2.5 Write a sanitized manual smoke checklist that runs OpenCode with only `@weave/adapter-opencode` enabled and verifies a Weave-authored agent appears after materialization.

### [x] 3.0 Implement safe reconciliation using canonical agent identity and ownership checks

#### 3.0 Proof Artifact(s)

- Test: `bun test packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts` passes the create case demonstrates a missing Weave-managed agent is created using the Canonical Agent Name.
- Test: `bun test packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts` passes the update case demonstrates an existing Weave-managed agent is updated in place without changing identity.
- Test: `bun test packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts` passes the collision case demonstrates a same-named foreign OpenCode agent is rejected safely.

#### 3.0 Tasks

- [x] 3.1 Create `packages/adapters/opencode/src/reconcile-agent.ts` to encapsulate upsert-only reconciliation rules.
- [x] 3.2 Use `descriptor.name` as the Canonical Agent Name for all matching and durable identity checks.
- [x] 3.3 Treat `displayName`, `description`, and other presentation fields as mutable display metadata, not identity.
- [x] 3.4 Add an explicit Weave-ownership check before update and return a collision error when a same-named foreign OpenCode agent is found.
- [x] 3.5 Keep first-slice behavior upsert-only by refusing automatic delete, prune, or forced takeover operations.
- [x] 3.6 Add `packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts` coverage for create, update, and foreign-agent collision cases.

### [ ] 4.0 Add model and skill validation to the materialization pipeline

#### 4.0 Proof Artifact(s)

- Test: `bun test packages/adapters/opencode/src/__tests__/model-resolution.test.ts` passes demonstrates the adapter calls `resolveAdapterModelIntent()` with OpenCode model context.
- Test: `bun test packages/adapters/opencode/src/__tests__/adapter.test.ts` passes an unsupported explicit subagent model case demonstrates materialization fails intentionally.
- Test: `bun test packages/adapters/opencode/src/__tests__/skill-discovery.test.ts` passes both success and missing-skill cases demonstrates real discovery plus hard-error resolution semantics.

#### 4.0 Tasks

- [ ] 4.1 Create `packages/adapters/opencode/src/model-resolution.ts` to gather OpenCode model context and call `resolveAdapterModelIntent()`.
- [ ] 4.2 Replace the current `descriptor.models[0]` translation shortcut with resolved-and-validated model selection before the final agent payload is materialized.
- [ ] 4.3 Fail fast when explicit subagent model intent cannot be satisfied by the available OpenCode model set.
- [ ] 4.4 Create `packages/adapters/opencode/src/skill-discovery.ts` to return real `SkillInfo[]` entries for the OpenCode-visible skills the adapter can discover.
- [ ] 4.5 Keep engine-owned missing-skill semantics intact by surfacing unresolved declared skills as hard errors rather than silent skips.
- [ ] 4.6 Add `translate-agent`, model-resolution, and skill-discovery tests covering supported resolution, unsupported explicit model failure, and missing declared skill failure.

### [ ] 5.0 Document the adapter shape and prove acceptance for the first slice

#### 5.0 Proof Artifact(s)

- Document: `docs/adr/0003-opencode-adapter-materialization-shape.md` explains the SDK-first, plugin/runtime-first, and ownership-safe adapter decisions.
- Document: `docs/adapter-readiness-status.md` and any updated OpenCode adapter docs show `@weave/adapter-opencode` as a real first-slice materialization path with explicit non-goals.
- Quality gate: `bun run typecheck && bun test packages/adapters/opencode/src/__tests__/adapter.test.ts && bun test packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts && bun test packages/adapters/opencode/src/__tests__/model-resolution.test.ts && bun test packages/adapters/opencode/src/__tests__/skill-discovery.test.ts && bun test packages/adapters/opencode/src/__tests__/run-workflow.test.ts` passes, and the manual smoke checklist records the exact sanitized verification command/path.

#### 5.0 Tasks

- [ ] 5.1 Write `docs/adr/0003-opencode-adapter-materialization-shape.md` documenting the SDK-first, plugin/runtime-first, injected-client, and ownership-safe decisions.
- [ ] 5.2 Update `docs/adapter-readiness-status.md` and any other OpenCode adapter docs so the package is described as a real first-slice materialization path with explicit remaining non-goals.
- [ ] 5.3 Update `docs/adapter-boundary.md` only if implementation reveals clarification needs that stay within the current boundary, without introducing new engine contracts.
- [ ] 5.4 Run targeted adapter tests plus `bun run typecheck` and record the exact commands as planned proof artifacts.
- [ ] 5.5 Finalize the sanitized manual smoke artifact/checklist so `/SDD-4-validate-spec-implementation` has a reproducible plugin/runtime verification path.
