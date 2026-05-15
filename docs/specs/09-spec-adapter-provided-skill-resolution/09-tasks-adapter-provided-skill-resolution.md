## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/engine/src/skill-resolution.ts` | New pure engine module for `SkillInfo`, `ResolvedSkill`, `resolveSkillsForAgent()`, `resolveSkillsForConfig()`, and typed missing-skill errors. |
| `packages/engine/src/__tests__/skill-resolution.test.ts` | New isolated tests for single-agent resolution, disabled-skill filtering, missing-skill errors, batch resolution, and generated category shuttles. |
| `packages/engine/src/index.ts` | Public barrel that must export the new skill-resolution types and functions. |
| `packages/engine/src/adapter.ts` | Transitional `HarnessAdapter` contract currently contains deprecated `SkillConfig` and `loadSkill()` that must move toward adapter-provided skill context. |
| `packages/engine/src/runner.ts` | Existing `TODO(#12)` lifecycle slot where adapter-provided skill context should be resolved before agent materialization. |
| `packages/engine/src/run-agent-effects.ts` | Run-agent effect shape may need a `resolvedSkills` field so adapters/debuggers can observe resolved skill data. |
| `packages/engine/src/__tests__/runner.test.ts` | Existing runner integration tests to extend for skill resolution, category shuttles, disabled agents, and effect emission. |
| `packages/engine/src/__tests__/mock-adapter.ts` | Mock adapter must reflect the updated transitional skill contract without relying on engine-driven `loadSkill()`. |
| `packages/engine/src/descriptors.ts` | Existing category shuttle generation helper that config-wide skill resolution should reuse instead of duplicating category semantics. |
| `docs/adapter-boundary.md` | Canonical engine/adapter boundary document; contains skill-resolution data-flow guidance and a dead Spec 05 link. |
| `docs/product-vision.md` | Product source of truth; contains skill-resolution positioning and a dead Spec 05 link. |
| `packages/engine/README.md` | Engine package guide; currently references planned Spec 05 skill resolution and transitional `loadSkill()`. |

### Notes

- Unit tests should live alongside engine code under `packages/engine/src/__tests__/`.
- Use `bun test packages/engine/src/__tests__/skill-resolution.test.ts` for focused skill-resolution checks.
- Use `bun test packages/engine/src/__tests__/runner.test.ts` for runner/effect integration checks.
- Use `bun run typecheck`, `bun run lint`, and `bun run test` as repository quality gates.
- Keep engine helpers pure: no harness directory scans, no real skill file reads, no concrete harness API calls, and no real harness process startup in tests.
- Planning assumption for the open adapter-surface question: prefer the smallest explicit adapter-provided context flow, such as `loadAvailableSkills(): Promise<SkillInfo[]>`, unless implementation discovers a cleaner non-breaking runner-options path.
- Planning assumption for `SkillInfo`: standardize only `name` in this slice; keep optional `scope`, `path`, `description`, content, and harness metadata adapter-owned pass-through unless a test proves a second engine-owned field is required.

## Tasks

### [x] 1.0 Define public skill resolution types and exports

#### 1.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/skill-resolution.test.ts` passes type-focused coverage demonstrating `SkillInfo.name` is the stable matching key and `ResolvedSkill` preserves adapter-provided metadata without harness discovery.
- Typecheck: `bun run typecheck` passes demonstrating `SkillInfo`, `ResolvedSkill`, `resolveSkillsForAgent()`, and `resolveSkillsForConfig()` are exported from `@weave/engine`.
- Code review artifact: `packages/engine/src/skill-resolution.ts` contains no OpenCode, Claude Code, Pi, `Bun.file`, or process-spawning references, demonstrating harness-neutral type definitions.

#### 1.0 Tasks

- [x] 1.1 Create `packages/engine/src/skill-resolution.ts` with exported `SkillInfo`, `ResolvedSkill`, input/result types, and a discriminated missing-skill error type.
- [x] 1.2 Require `SkillInfo.name` as the only engine-owned matching key and keep all other metadata adapter-owned and pass-through.
- [x] 1.3 Add type-focused tests proving adapter metadata can be preserved without engine inspection of paths, content, or harness-specific fields.
- [x] 1.4 Export all public skill-resolution types and functions from `packages/engine/src/index.ts`.
- [x] 1.5 Run `bun run typecheck` to verify the new public API is importable across the workspace.

### [ ] 2.0 Implement single-agent skill resolution

#### 2.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/skill-resolution.test.ts` passes cases for resolving an available requested skill, preserving declaration order, and returning `ok([])` for no skills.
- Test: `bun test packages/engine/src/__tests__/skill-resolution.test.ts` passes disabled-skill coverage demonstrating `disabled.skills ["tdd"]` filters `skills ["tdd"]` without a missing-skill error.
- Test: `bun test packages/engine/src/__tests__/skill-resolution.test.ts` passes missing-skill coverage demonstrating a non-disabled unknown skill returns a typed `err` with `agentName` and `skillName`.

#### 2.0 Tasks

- [ ] 2.1 Implement `resolveSkillsForAgent(input)` as a pure function returning `Result<ResolvedSkill[], SkillResolutionError[]>` or an equivalent explicit `neverthrow` result shape.
- [ ] 2.2 Match requested `agentSkills` to `availableSkills` by exact `SkillInfo.name`.
- [ ] 2.3 Preserve the order of non-disabled requested skills in the returned resolved-skill list.
- [ ] 2.4 Filter any requested skill present in `disabledSkills` before missing-skill validation.
- [ ] 2.5 Return `ok([])` for missing, undefined, or empty `agentSkills` inputs.
- [ ] 2.6 Return typed `err` entries containing at least `type`, `agentName`, and `skillName` for missing non-disabled skills.
- [ ] 2.7 Add focused tests for available skill resolution, declaration order, disabled-skill filtering, no-skills input, and missing non-disabled skill errors.

### [ ] 3.0 Implement config-wide resolution including generated category shuttles

#### 3.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/skill-resolution.test.ts` passes config-wide coverage demonstrating all declared agents are represented in resolution output.
- Test: `bun test packages/engine/src/__tests__/skill-resolution.test.ts` passes category coverage demonstrating generated `shuttle-{category}` descriptors participate in resolution using existing descriptor semantics.
- Test: `bun test packages/engine/src/__tests__/skill-resolution.test.ts` passes batch-error coverage demonstrating multiple missing non-disabled skills are accumulated and reported together.

#### 3.0 Tasks

- [ ] 3.1 Implement `resolveSkillsForConfig(input)` using `WeaveConfig`, adapter-provided `availableSkills`, and `config.disabled.skills`.
- [ ] 3.2 Reuse `generateCategoryShuttles(config)` so generated category shuttle behavior matches runner materialization semantics.
- [ ] 3.3 Include declared agents and generated category shuttles in the batch result with stable agent-name keys.
- [ ] 3.4 Skip disabled generated shuttles consistently with existing descriptor behavior.
- [ ] 3.5 Accumulate missing non-disabled skill errors across all agents instead of returning only the first error.
- [ ] 3.6 Add tests for declared-agent batch output, generated category shuttle output, disabled-skill behavior in batch mode, and multiple accumulated missing-skill errors.

### [ ] 4.0 Wire resolved skills into runner and adapter-facing effects

#### 4.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/runner.test.ts` passes coverage demonstrating `WeaveRunner.run()` resolves adapter-provided skills before `spawnSubagent` and emits resolved skills for each spawned agent.
- Test: `bun test packages/engine/src/__tests__/runner.test.ts` passes coverage demonstrating generated category shuttles receive resolved skill data and disabled agents do not emit skill-resolution effects.
- Test: `bun test packages/engine/src/__tests__/runner.test.ts` passes sanitized-effect coverage demonstrating serialized run-agent effects do not expose adapter-owned skill paths, skill contents, API keys, tokens, or `.env` values.
- Test: `bun test packages/engine/src/__tests__/mock-adapter.ts` compiles through `bun run typecheck`, demonstrating the mock adapter no longer depends on engine-driven `loadSkill()` as the skill-resolution path.
- Code review artifact: `packages/engine/src/runner.ts` contains no directory scanning, skill-file reads, or harness-specific skill lookup, demonstrating adapters provide skill context explicitly.

#### 4.0 Tasks

- [ ] 4.1 Replace the runner's `TODO(#12)` placeholder with skill resolution based on explicit adapter-provided available skill context.
- [ ] 4.2 Update the transitional adapter surface to provide available skills without engine-driven `loadSkill()` as the resolution path.
- [ ] 4.3 Update `RunAgentEffect` or an equivalent adapter-facing materialization structure to include `resolvedSkills` for each spawned agent.
- [ ] 4.4 Ensure disabled agents do not emit resolved-skill effects or require missing-skill checks during materialization.
- [ ] 4.5 Ensure generated category shuttles receive resolved-skill data before `spawnSubagent`.
- [ ] 4.6 Update `MockAdapter` and runner tests for the new skill context flow without starting a real harness.
- [ ] 4.7 Add a runner test proving no harness-specific skill lookup, directory scanning, or skill-file read is required by engine code.
- [ ] 4.8 Add sanitized-effect coverage proving adapter-provided skill metadata such as paths, content, tokens, API keys, and `.env` values is not emitted by engine debug/effect data.

### [ ] 5.0 Update documentation and boundary references

#### 5.0 Proof Artifact(s)

- Diff: `docs/adapter-boundary.md`, `docs/product-vision.md`, and `packages/engine/README.md` link to `docs/specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md`, demonstrating dead Spec 05 skill-loader references are corrected.
- Test: `bun run lint` passes demonstrating Markdown-adjacent repository changes do not introduce lint failures in configured source paths.
- Security review artifact: Warp review notes for issue #12 changes confirm no secrets, local skill contents, or harness-owned skill paths are exposed in debug/effect data.

#### 5.0 Tasks

- [ ] 5.1 Update `docs/adapter-boundary.md` to link skill-resolution references to Spec 09 instead of the dead Spec 05 path.
- [ ] 5.2 Update `docs/product-vision.md` to link skill-resolution references to Spec 09 instead of the dead Spec 05 path.
- [ ] 5.3 Update `packages/engine/README.md` so the skill-resolution API description names Spec 09 and the new adapter-provided context flow.
- [ ] 5.4 Document any final transitional adapter-surface decision made during implementation, especially if the method is named `loadAvailableSkills()` or if context is supplied through runner options.
- [ ] 5.5 Run `bun run lint` to verify source formatting/linting remains clean.
- [ ] 5.6 Request Warp security review for issue #12 implementation changes before considering implementation complete.
