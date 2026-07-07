# 09-spec-adapter-provided-skill-resolution.md

## Introduction/Overview

Implement **Adapter-Provided Skill Resolution** in `@weaveio/weave-engine` so Weave resolves agent `skills [...]` declarations against an explicit list of skills supplied by the adapter or harness. The primary goal is to keep skill matching, disabled-skill filtering, and missing-skill errors in the harness-agnostic engine while preserving adapter ownership of skill discovery, skill loading, file formats, and harness-specific mounting.

This spec is based on GitHub issue [#12](https://github.com/weave-io/weave/issues/12) and follows the boundary decision in [`docs/adapter-boundary.md`](../../adapter-boundary.md): adapters discover available skills; the engine only resolves references against adapter-provided context.

## Goals

- Export a public `SkillInfo`, `ResolvedSkill`, `resolveSkillsForAgent()`, and `resolveSkillsForConfig()` API from `@weaveio/weave-engine`.
- Filter globally disabled skills from agent-level resolution using `config.disabled.skills`.
- Return explicit `neverthrow` `Result` errors when a non-disabled requested skill is missing from the adapter-provided skill list.
- Include generated category shuttles in config-wide skill resolution so routed specialist agents receive the same resolution behavior as declared agents.
- Move the transitional adapter contract away from engine-driven `loadSkill()` behavior and toward adapter-provided skill context.

## User Stories

- **As an engine developer**, I want skill resolution to be implemented as a pure helper so that skill behavior is deterministic and testable without a real harness.
- **As an adapter maintainer**, I want to provide the engine with available skills discovered by my harness so that the engine does not need to know my harness's skill directories, file formats, or loading lifecycle.
- **As a config author**, I want disabled skills to be ignored during resolution so that project or global policy can safely turn off a skill even when agents still reference it.
- **As a Weave maintainer**, I want missing non-disabled skills to produce typed errors so that invalid configurations fail clearly instead of silently dropping required behavior.
- **As a category author**, I want generated `shuttle-{category}` agents to resolve skills consistently so that category-specific agents work like first-class declared agents.

## Demoable Units of Work

### Unit 1: Public Skill Resolution Types

**Purpose:** Establish the shared engine vocabulary for adapter-provided skills and resolved agent skill references without introducing harness-specific assumptions.

**Functional Requirements:**
- The system shall define and export a `SkillInfo` type representing a skill descriptor supplied by an adapter.
- The system shall define and export a `ResolvedSkill` type representing a skill selected for a specific agent after disabled-skill filtering and availability checks.
- The system shall require `SkillInfo.name` as the stable matching key for `AgentConfig.skills` entries.
- The system shall allow `SkillInfo` to carry adapter-owned metadata without requiring the engine to inspect harness-specific file locations, mounting details, or skill content formats.
- The system shall export the public skill-resolution types from `packages/engine/src/index.ts`.

**Proof Artifacts:**
- `Typecheck: bun run typecheck` demonstrates `SkillInfo` and `ResolvedSkill` are exported and usable by workspace packages.
- `Test: packages/engine/src/__tests__/skill-resolution.test.ts passes` demonstrates the public types support named skill matching without harness discovery.
- `Code review artifact: packages/engine/src/skill-resolution.ts contains no OpenCode, Claude Code, Pi, Bun.file, or process-spawning references` demonstrates type definitions remain harness-neutral.

### Unit 2: Resolve Skills for One Agent

**Purpose:** Provide the core pure helper that resolves one agent's declared skill names against adapter-provided available skills.

**Functional Requirements:**
- The system shall provide `resolveSkillsForAgent(input)` in `@weaveio/weave-engine`.
- The system shall accept `agentName`, `agentSkills`, `availableSkills`, and `disabledSkills` as explicit input fields.
- The system shall return a successful `Result` containing resolved skills in the same order as the agent's non-disabled `skills [...]` declaration.
- The system shall omit requested skills that appear in `disabledSkills` without reporting them as missing.
- The system shall return an error `Result` when a requested skill is neither disabled nor present in `availableSkills`.
- The system shall include enough error detail to identify the agent name and missing skill name without exposing secrets or harness-owned implementation details.
- The system shall return a successful empty result for agents with no `skills` field or an empty `skills` array.

**Proof Artifacts:**
- `Test: requested available skill resolves successfully` demonstrates `skills ["tdd"]` matches `availableSkills [{ name: "tdd" }]`.
- `Test: disabled requested skill is filtered without error` demonstrates `disabled.skills ["tdd"]` returns no resolved skill and no missing-skill error.
- `Test: missing non-disabled skill returns err` demonstrates invalid references are visible to callers.
- `Test: no skills returns ok empty array` demonstrates agents without skill declarations remain valid.

### Unit 3: Resolve Skills for Full Config Including Category Shuttles

**Purpose:** Extend single-agent resolution across the normalized config so every materialized agent, including generated category shuttles, has deterministic resolved skill data.

**Functional Requirements:**
- The system shall provide `resolveSkillsForConfig(input)` in `@weaveio/weave-engine`.
- The system shall resolve skills for all declared agents in the provided `WeaveConfig`.
- The system shall include generated category shuttle descriptors in batch resolution using the same category-generation semantics used by the runner.
- The system shall apply `config.disabled.skills` consistently to declared agents and generated category shuttles.
- The system shall return all missing non-disabled skill errors in a typed `Result` failure rather than stopping at only the first missing skill.
- The system shall preserve agent names in the batch result so adapters and runner effects can associate resolved skills with the correct agent.

**Proof Artifacts:**
- `Test: config-wide resolution includes declared agents` demonstrates every `config.agents` entry is represented in the resolution output.
- `Test: config-wide resolution includes generated shuttle categories` demonstrates `shuttle-{category}` descriptors receive skill resolution.
- `Test: disabled skills apply in batch resolution` demonstrates global disabled policy is consistent across all agents.
- `Test: multiple missing skills are reported together` demonstrates typed errors are complete enough for users to fix invalid config in one pass.

### Unit 4: Runner and Adapter Boundary Transition

**Purpose:** Wire skill resolution into the current engine lifecycle without reintroducing engine-owned skill discovery or requiring adapters to mount concrete skills through the old `loadSkill()` pathway.

**Functional Requirements:**
- The system shall update the transitional `HarnessAdapter` contract away from `loadSkill(skill)` as an engine-driven loading method.
- The system shall define how adapter-provided available skills are passed into engine resolution before agent materialization.
- The system shall ensure `WeaveRunner.run()` resolves skills at the existing `TODO(#12)` lifecycle slot using explicit adapter-provided skill context.
- The system shall expose resolved skills in run-agent debug/effect data or another adapter-facing materialization structure so adapters can mount or apply skills using harness-specific mechanisms.
- The system shall not scan `.weave/skills/`, global skill directories, OpenCode skill directories, Claude Code skill directories, Pi skill directories, or any other harness-owned resource location from `@weaveio/weave-engine`.
- The system shall update isolated runner tests and mock adapter fixtures without starting a real harness.

**Proof Artifacts:**
- `Test: packages/engine/src/__tests__/runner.test.ts passes` demonstrates the runner resolves skills before materializing agents.
- `Test: mock adapter receives or exposes resolved skills for each spawned agent` demonstrates adapters can consume resolved skill context without `loadSkill()`.
- `Code review artifact: HarnessAdapter no longer uses engine-driven loadSkill as the skill-resolution path` demonstrates the transitional contract moved toward adapter-provided context.
- `Code review artifact: engine skill path contains no directory scanning or skill-file reads` demonstrates boundary compliance.

## Non-Goals (Out of Scope)

1. **Engine-owned skill discovery**: This spec does not scan `.weave/skills/`, global Weave skill directories, OpenCode skill directories, Pi skill directories, Claude Code skill directories, or any other harness-specific location.
2. **Harness-specific skill mounting**: This spec does not define how OpenCode, Claude Code, Pi, or any future harness physically mounts, installs, or renders skills.
3. **Skill file parsing or content validation**: This spec does not parse skill markdown, validate skill frontmatter, or inspect skill bodies; adapters own skill formats and may pass only normalized descriptors to the engine.
4. **Bundled self-mutation guidance as skills**: This spec does not move self-modification or agent-maintenance guidance into a skill package; related bundled documentation remains separate.
5. **New `.weave` DSL syntax**: This spec does not add new skill declaration syntax beyond the existing agent `skills ["..."]` array and `disable skills [...]` configuration.
6. **Complete adapter implementation for every harness**: This spec establishes the engine API and transitional contract; concrete adapter behavior may be implemented by follow-up adapter-specific work.

## Design Considerations

No specific UI design requirements identified. Any CLI, debug, or diagnostic output derived from skill resolution should use clear agent names and skill names, group missing-skill errors by agent where practical, and avoid exposing adapter-owned file paths or skill contents unless the adapter has explicitly sanitized them for display.

## Repository Standards

- Follow [`docs/adapter-boundary.md`](../../adapter-boundary.md): adapters own skill discovery/loading, while `@weaveio/weave-engine` owns skill matching/filtering against explicit inputs.
- Follow [`docs/product-vision.md`](../../product-vision.md): Weave provides harness-agnostic primitives and adapters translate those primitives into concrete harness behavior.
- Follow the public API style of `packages/engine/src/model-resolution.ts`: pure helper, explicit input object, typed output, no direct harness calls, and barrel exports through `packages/engine/src/index.ts`.
- Use existing schema concepts from `@weaveio/weave-core`: `AgentConfig.skills` and `disabled.skills` already define the config inputs for this feature.
- Use `neverthrow` for expected failure paths, including missing non-disabled skills. Return `Result<T, E>` with discriminated error types rather than throwing exceptions.
- Use Bun-only tooling and commands: `bun test`, `bun run typecheck`, and workspace scripts as needed.
- Add isolated tests with mocks and fixtures. Do not start real harnesses, read real harness skill directories, or rely on local user skill files in unit tests.
- Keep engine code free of `console.*`; use the shared pino logger only if implementation needs logging.
- Update documentation for any non-trivial adapter-boundary behavior or transitional interface change introduced during implementation.
- Use Conventional Commits when the later SDD task workflow creates the planning commit.

## Technical Considerations

- The likely implementation home is a new engine module such as `packages/engine/src/skill-resolution.ts`, exported from `packages/engine/src/index.ts`.
- `SkillInfo` should keep `name` as the only engine-required field. Optional metadata may be retained as adapter-owned data, but engine logic should not depend on harness-specific paths, formats, scope rules, or content fields unless a later approved spec standardizes them.
- `ResolvedSkill` should preserve enough source information for adapters to materialize skills and for debug output to explain which skill names resolved, while avoiding any requirement that the engine understand concrete harness mounting.
- `resolveSkillsForAgent()` should be deterministic, side-effect free, and easy to test with in-memory arrays.
- `resolveSkillsForConfig()` should reuse the same descriptor/category generation path as `WeaveRunner` so category shuttles are not resolved through a parallel, divergent implementation.
- Missing-skill failures should be represented as structured errors, such as a discriminated union carrying `type`, `agentName`, and `skillName` fields.
- Batch resolution should accumulate missing-skill errors across agents so the user can fix all missing references in one pass.
- The transitional `HarnessAdapter.loadSkill()` method is marked `@deprecated` in `packages/engine/src/adapter.ts` and was superseded by `loadAvailableSkills()` as part of this spec. It remains on the interface for backward compatibility; new adapters should implement `loadAvailableSkills()` instead.
- Dead documentation links to the older `docs/specs/05-spec-skill-loader/05-spec-skill-loader.md` have been removed from durable guides. Readers should use this spec (Spec 09) as the canonical skill-resolution reference. The retired Spec 05 is listed in [`docs/specs/README.md`](../README.md) under the retired specs table.
- Latest-standards research summary: Neverthrow documentation was consulted via Context7 (`/supermacro/neverthrow`, living GitHub wiki/docs). Relevant current guidance: avoid throwing for expected failures because TypeScript does not force callers to catch them; encode fallible paths with `Result`/`ResultAsync`; use `ok` and `err` with explicit success and error types. This supports `Result` errors for missing non-disabled skills and plain return values only for non-fallible helper internals.

## Security Considerations

- Skill resolution is security-relevant because incorrect matching or disabled-skill handling could enable behavior the user or project policy intended to turn off.
- Disabled skills must be filtered before missing-skill errors are emitted so intentionally disabled references do not pressure users to re-enable blocked behavior.
- Engine debug/effect data must not include skill file contents, credentials, local secret-bearing paths, `.env` data, API keys, tokens, or harness-private mounting details.
- Adapters remain responsible for sanitizing any harness-specific skill metadata before passing it into logs, diagnostics, proof artifacts, or user-visible output.
- Missing-skill errors should identify the missing skill name and agent name only; they should not guess or reveal filesystem search paths.
- Because this work touches feature enablement, disabled policy, and adapter-provided inputs, the implementation plan and completed changes should receive a Warp security audit before execution is considered complete.

## Success Metrics

1. **API availability**: `SkillInfo`, `ResolvedSkill`, `resolveSkillsForAgent()`, and `resolveSkillsForConfig()` are exported from `@weaveio/weave-engine` and pass `bun run typecheck`.
2. **Correct filtering**: Tests prove `disabled.skills` suppresses matching requested skills without generating missing-skill errors.
3. **Clear failures**: Tests prove missing non-disabled skills return typed `Result` errors with agent and skill names.
4. **Boundary compliance**: Engine skill-resolution code performs no filesystem scanning, harness API calls, or adapter-owned discovery.
5. **Category coverage**: Tests prove generated category shuttles participate in config-wide skill resolution.
6. **Adapter transition readiness**: Runner or adapter-facing effect tests prove resolved skills are available for materialization without relying on engine-driven `loadSkill()`.

## Open Questions

1. Should the transitional adapter surface expose available skills via a method such as `loadAvailableSkills()` or should `WeaveRunner` receive available skills through a separate constructor/input context? The issue requires adapter-provided context but does not mandate the exact temporary API shape.
2. Should `SkillInfo` standardize optional fields beyond `name` in this first slice, such as `scope`, `path`, or `description`, or should those remain adapter-owned metadata until a harness adapter needs them?
