## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/engine/src/compose.ts` | Defines `AgentDescriptor` and `composeAgentDescriptor()`, the main descriptor contract and construction path. |
| `packages/engine/src/index.ts` | Public `@weave/engine` barrel export that adapter packages import from. |
| `packages/engine/src/descriptors.ts` | Generates category shuttles and currently controls disabled generated-shuttle omission. |
| `packages/engine/src/runner.ts` | Existing runtime path that composes descriptors and passes them to adapters; compatibility must be preserved. |
| `packages/engine/src/template-context.ts` | Holds category prompt context types and may need alignment with descriptor category metadata. |
| `packages/engine/src/run-agent-effects.ts` | Carries `AgentDescriptor` through engine effects; must not leak unsafe metadata. |
| `packages/engine/src/__tests__/compose.test.ts` | Primary tests for descriptor shape, prompt composition, identity fields, skills, policy, delegation, and category absence/presence. |
| `packages/engine/src/__tests__/descriptors.test.ts` | Tests category shuttle generation, disabled generated shuttles, and category provenance support. |
| `packages/engine/src/__tests__/runner.test.ts` | Tests runner compatibility and adapter/effect receipt of stable descriptors. |
| `docs/adapter-boundary.md` | Main architecture doc that must link and summarize the stable descriptor contract. |
| `docs/prompt-composition.md` | Existing descriptor/prompt composition documentation that may mention the descriptor shape. |
| `docs/specs/14-spec-preserve-category-metadata/14-spec-preserve-category-metadata.md` | Adjacent spec that owns category metadata preservation mechanics and must remain distinct from Spec 16. |
| `docs/specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md` | Adjacent spec that owns the API returning descriptors and must remain distinct from Spec 16. |
| `docs/specs/16-spec-stable-adapter-descriptor-contract/16-spec-stable-adapter-descriptor-contract.md` | Source spec for this task list and contract documentation expectations. |

### Notes

- Tests should use `bun:test` and in-memory fixtures or `MockAdapter`; do not launch a real harness.
- Use `bun run --filter '@weave/engine' typecheck`, targeted `bun test packages/engine/src/__tests__/...`, and final `bun run lint && bun run typecheck && bun test packages/engine/src` proof commands.
- Follow the engine/adapter boundary: engine produces normalized descriptors; adapters own concrete harness ids, files, model lookup, tool-name mapping, hooks, and runtime behavior.
- Keep `AgentDescriptor.skills` as requested skill names only; do not add resolved skill payloads to descriptors.
- Mention GitHub issue #72 in the eventual PR.

## Tasks

### [x] 1.0 Formalize `AgentDescriptor` identity fields

#### 1.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/compose.test.ts` passes with representative builtin descriptor assertions demonstrating `AgentDescriptor.name` is the stable internal id and optional `displayName` is presentation metadata only.
- Typecheck: `bun run --filter '@weave/engine' typecheck` passes demonstrating the exported `AgentDescriptor` type, including optional `displayName`, compiles for engine consumers.
- Documentation: `docs/adapter-boundary.md#stable-adapter-descriptor-contract` field description demonstrates `name` and `displayName` semantics are documented without harness-specific ids.

#### 1.0 Tasks

- [x] 1.1 Add optional `displayName?: string` to `AgentDescriptor` in `packages/engine/src/compose.ts` while keeping `name` as the required stable internal id.
- [x] 1.2 Update `composeAgentDescriptor()` to populate `displayName` from engine-owned descriptor composition rules without replacing or mutating `name`.
- [x] 1.3 Add or update `compose.test.ts` assertions for a representative builtin agent proving `name` remains stable and `displayName` is optional presentation metadata.
- [x] 1.4 Verify `AgentDescriptor` remains exported from `packages/engine/src/index.ts` for adapter imports.
- [x] 1.5 Document `name` versus `displayName` semantics in `docs/adapter-boundary.md`.

### [x] 2.0 Stabilize non-category descriptor contract fields

#### 2.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/compose.test.ts` passes with custom-agent descriptor assertions demonstrating `composedPrompt`, ordered `models`, abstract `rawToolPolicy`/`effectiveToolPolicy`, requested skill names, and `delegationTargets` match the documented adapter-facing shape.
- Test: `bun test packages/engine/src/__tests__/compose.test.ts` passes with prompt-source assertions demonstrating descriptors expose `composedPrompt` and do not expose raw `prompt`, `prompt_file`, or `prompt_append` as adapter inputs.
- Documentation: `docs/adapter-boundary.md#stable-adapter-descriptor-contract` states model resolution, concrete tool mapping, and harness resource generation remain adapter-owned.

#### 2.0 Tasks

- [x] 2.1 Review current `AgentDescriptor` fields in `compose.ts` against Spec 16 and keep the contract limited to composed prompt, ordered model intent, abstract policy, delegation targets, and requested skill names.
- [x] 2.2 Add `compose.test.ts` coverage for a custom agent with inline prompt, models, tool policy, requested skills, and delegation-capable configuration.
- [x] 2.3 Add `compose.test.ts` coverage proving raw prompt source fields are not present on returned descriptors.
- [x] 2.4 Update `docs/adapter-boundary.md` to state that model availability, selected-model lookup, concrete model field formatting, concrete tool mapping, and harness resource generation remain adapter-owned.
- [x] 2.5 Confirm descriptor skill data remains requested skill names only and does not include resolved skill payloads, paths, contents, or adapter-private metadata.

### [x] 3.0 Represent category metadata and disabled entries in descriptors

#### 3.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/descriptors.test.ts packages/engine/src/__tests__/compose.test.ts` passes with generated `shuttle-frontend` assertions demonstrating category name, optional description, and declared patterns appear in `AgentDescriptor.category` without glob expansion.
- Test: `bun test packages/engine/src/__tests__/compose.test.ts` passes with regular-agent assertions demonstrating category metadata is absent for non-category descriptors.
- Test: `bun test packages/engine/src/__tests__/runner.test.ts` or materialization-focused engine test passes with disabled-agent assertions demonstrating disabled declared agents and suppressed category shuttles are omitted rather than emitted as disabled descriptors.

#### 3.0 Tasks

- [x] 3.1 Add a normalized optional category metadata shape to `AgentDescriptor` that includes category name, optional description, and declared patterns only.
- [x] 3.2 Preserve category metadata from category shuttle generation through descriptor composition without duplicating Spec 14's category-generation responsibilities.
- [x] 3.3 Add `descriptors.test.ts` coverage proving generated shuttles can be associated with source category metadata and disabled generated shuttles remain omitted.
- [x] 3.4 Add `compose.test.ts` coverage proving generated category shuttle descriptors include category metadata and regular agents omit it.
- [x] 3.5 Add runner or materialization-focused coverage proving disabled declared agents and suppressed generated shuttles are omitted from adapter-facing descriptor output.
- [x] 3.6 Verify category patterns are preserved exactly as declared and no engine code expands globs or scans project files.

### [ ] 4.0 Document descriptor contract and preserve compatibility

#### 4.0 Proof Artifact(s)

- Documentation: `docs/specs/16-spec-stable-adapter-descriptor-contract/16-spec-stable-adapter-descriptor-contract.md` and `docs/adapter-boundary.md` cross-link correctly and distinguish Spec 16 from category metadata and materialization API specs.
- Test: `bun test packages/engine/src/__tests__/runner.test.ts` passes demonstrating existing `WeaveRunner` behavior remains compatible with the stable `AgentDescriptor` contract.
- CLI: `bun run lint && bun run typecheck && bun test packages/engine/src` completes successfully demonstrating repository quality gates pass for the engine descriptor contract work.

#### 4.0 Tasks

- [ ] 4.1 Correct the stale `docs/adapter-boundary.md` link that currently points to a missing Spec 14 stable-descriptor path so it points to Spec 16.
- [ ] 4.2 Add a compact descriptor field table to `docs/adapter-boundary.md` or a linked section that documents stable fields, ownership, and adapter responsibilities.
- [ ] 4.3 Update `docs/prompt-composition.md` if it documents `AgentDescriptor` so the descriptor shape matches the stable contract.
- [ ] 4.4 Add cross-links from Spec 16 to Spec 14 category metadata and Spec 15 materialization API to clarify boundaries.
- [ ] 4.5 Run `bun test packages/engine/src/__tests__/runner.test.ts` to verify existing runner behavior remains compatible.
- [ ] 4.6 Run `bun run lint && bun run typecheck && bun test packages/engine/src` and record sanitized command output as final proof.
