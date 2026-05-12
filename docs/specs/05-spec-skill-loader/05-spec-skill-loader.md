# 05-spec-skill-loader

**Related issue:** [weave-io/weave#12](https://github.com/weave-io/weave/issues/12)

**Related docs:** [Adapter Boundary](../../adapter-boundary.md) · [Product Vision](../../product-vision.md)

## Introduction/Overview

Weave agents reference skills by name (`skills: ["tdd", "code-review"]`), and users can disable skills via `disable skills [...]`. The harness (Pi, Claude Code, OpenCode) owns skill discovery — it knows where skills live on disk and how to load their content. Weave's job is to provide a **skill resolution API** that accepts the harness-provided skill list and an agent's declared skill references, then returns the matched, filtered skills for that agent.

This follows the same adapter-to-Weave API pattern established by `resolveAdapterModelIntent()`: the adapter pushes harness context in, Weave resolves it against declared config, and returns normalized output. No filesystem access, no side effects — a pure composition function.

## Goals

- Provide a pure skill resolution API that accepts available skills (from the harness) and returns resolved skills for a given agent
- Filter out skills listed in `WeaveConfig.disabled.skills`
- Match agent-declared `skills: [...]` against the harness-provided skill list
- Return clear errors when an agent references a skill that is not available
- Follow the established adapter-to-Weave API pattern (`resolveAdapterModelIntent` style) for consistency
- Expose the resolved skill list so that prompt composition (#6) can inject skill content into agent prompts

## User Stories

- **As an adapter developer**, I want to pass the harness's discovered skills into a Weave API and get back the resolved skills for each agent, so that I don't have to implement skill matching and filtering logic in every adapter.
- **As a Weave user**, I want my agents' `skills: ["tdd"]` declarations to be matched against whatever skills my harness provides, so that the right skill content gets injected into agent prompts.
- **As a Weave user**, I want `disable skills ["tdd"]` in my config to exclude skills from resolution regardless of what the harness provides, so that I can turn off skills without removing them from the harness.
- **As an adapter developer**, I want clear error feedback when an agent references a skill name that the harness didn't provide, so that I can surface helpful diagnostics to the user.

## Demoable Units of Work

### Unit 1: Skill Resolution Function

**Purpose:** Create the core `resolveSkillsForAgent()` function — a pure function that accepts harness-provided skills and agent config, and returns the matched/filtered skill list. This is the primary API surface.

**Functional Requirements:**

- The system shall export a `resolveSkillsForAgent()` function from `@weave/engine`
- The function shall accept a `SkillResolutionInput` containing: the agent's declared skill names, the harness-provided available skills, and the disabled skills list
- The function shall return `Result<ResolvedSkill[], SkillResolutionError>` using `neverthrow`
- The function shall match agent-declared skill names against available skills by name (exact string match)
- The function shall exclude any skill whose name appears in the disabled skills list, even if the agent references it
- The function shall return an error when an agent references a skill name that is not in the available skills list and is not disabled
- The function shall be pure — no filesystem access, no side effects, no logging of its own
- The `ResolvedSkill` type shall include at minimum: `name` (string) and `content` (string)
- The `SkillInfo` type (harness-provided input) shall include at minimum: `name` (string) and `content` (string)

**Proof Artifacts:**

- Test: agent with `skills: ["tdd"]` and available skill `"tdd"` → returns resolved skill — demonstrates happy-path matching
- Test: agent with `skills: ["tdd"]` and disabled `["tdd"]` → returns empty list — demonstrates filtering
- Test: agent with `skills: ["tdd"]` and no available skill `"tdd"` → returns error — demonstrates missing skill detection
- Test: agent with no `skills` field → returns empty list — demonstrates no-op case
- Test: agent with `skills: ["tdd", "code-review"]` and both available → returns both in order — demonstrates multi-skill matching

### Unit 2: Batch Skill Resolution for All Agents

**Purpose:** Create a higher-level `resolveSkillsForConfig()` function that resolves skills for every agent in a `WeaveConfig` in one call. This is the convenience API adapters will typically use.

**Functional Requirements:**

- The system shall export a `resolveSkillsForConfig()` function from `@weave/engine`
- The function shall accept a `WeaveConfig` and a list of harness-provided available skills
- The function shall call `resolveSkillsForAgent()` for each agent in the config (including generated category shuttles)
- The function shall return `Result<Record<string, ResolvedSkill[]>, SkillResolutionError>` — a map from agent name to its resolved skills
- The function shall use `WeaveConfig.disabled.skills` for filtering, without requiring the caller to extract it
- The function shall aggregate errors from all agents — if multiple agents reference missing skills, all errors are reported together
- The function shall skip agents that declare no `skills` field (they get an empty array in the result)

**Proof Artifacts:**

- Test: config with two agents referencing different skills → returns correct skills per agent — demonstrates per-agent resolution
- Test: config with disabled skills → those skills excluded across all agents — demonstrates config-level filtering
- Test: config with one agent referencing a missing skill → returns error identifying the agent and skill — demonstrates error aggregation
- Test: config with no agents declaring skills → returns empty arrays for all — demonstrates no-op baseline

### Unit 3: HarnessAdapter Interface Update and Documentation

**Purpose:** Update the `HarnessAdapter` interface to reflect the corrected data flow (adapter pushes skills to Weave, not the reverse), and document the skill resolution API pattern.

**Functional Requirements:**

- The `HarnessAdapter` interface shall remove the `loadSkill(skill: SkillConfig)` method — adapters no longer receive skills from Weave
- The `HarnessAdapter` interface shall add a `getAvailableSkills(): Promise<SkillInfo[]>` method — adapters provide skills to Weave
- The `SkillConfig` type in `adapter.ts` shall be replaced by the new `SkillInfo` type (or removed if `SkillInfo` lives in a separate module)
- The `MockAdapter` test double shall be updated to implement the new interface
- The `WeaveRunner.run()` TODO for skill loading shall be updated to call `adapter.getAvailableSkills()` and pass the result to `resolveSkillsForConfig()`
- The resolved skills shall be stored on the runner or passed to a future prompt composition step
- Documentation in `docs/product-vision.md` shall reflect the skill resolution API pattern (already updated in this spec's prep work)

**Proof Artifacts:**

- Test: `MockAdapter.getAvailableSkills()` returns configured skills — demonstrates new interface method works
- Test: `WeaveRunner.run()` calls `getAvailableSkills()` and resolves skills before spawning agents — demonstrates end-to-end integration
- Test: runner with disabled skills filters correctly through the full pipeline — demonstrates config-to-resolution flow
- Docs: `docs/product-vision.md` updated with skill resolution in the adapter-to-Weave API pattern diagram

## Non-Goals (Out of Scope)

1. **Skill file discovery from disk**: Weave does not scan `~/.weave/skills/` or `.weave/skills/`. Skill discovery is an adapter/harness concern. Each harness has its own conventions for where skills live and how they're structured.
2. **Skill content parsing or validation**: Weave receives skill content as a string from the adapter. Parsing skill metadata (e.g., description, triggers) from that content is a future concern.
3. **Prompt composition / injection**: Actually injecting resolved skill content into agent prompts is handled by #6 (prompt composition). This spec produces the resolved skill list that #6 will consume.
4. **Adapter implementations**: How each adapter implements `getAvailableSkills()` (e.g., scanning directories, reading `SKILL.md` files) is adapter-owned and out of scope.
5. **Builtin skills shipped with Weave**: This spec covers harness-provided skills only. Bundling skills with Weave is a future concern.
6. **Skill priority / override semantics**: If the harness provides two skills with the same name (e.g., from global and project scope), the adapter is responsible for resolving that conflict before passing skills to Weave. Weave receives a flat, deduplicated list.

## Design Considerations

No specific design requirements identified. This is an engine-internal API with no UI surface.

## Repository Standards

- **neverthrow**: All fallible functions return `Result<T, E>` with discriminated union error types
- **Pure functions**: Skill resolution functions are pure — no I/O, no side effects, no logger calls in the resolution logic itself
- **Pino logging**: The `WeaveRunner` integration (Unit 3) uses the shared pino logger for lifecycle events
- **Bun-only**: Runtime and test runner
- **Testing**: All tests use in-memory inputs — no filesystem, no mocks needed for the pure resolution functions; `MockAdapter` for runner integration
- **Barrel exports**: Export public types and functions from `packages/engine/src/index.ts`
- **Pattern precedent**: Follow the `resolveAdapterModelIntent()` pattern — input interface, result type, pure function, discriminated error union

## Technical Considerations

- **Type definitions**: New types live in `packages/engine/src/skill-resolution.ts`:

  ```ts
  /** Skill info provided by the harness/adapter. */
  interface SkillInfo {
    name: string;
    content: string;
  }

  /** Input to the skill resolution function. */
  interface SkillResolutionInput {
    /** Skill names declared by the agent (from AgentConfig.skills). */
    agentSkills: string[];
    /** Skills provided by the harness via adapter.getAvailableSkills(). */
    availableSkills: SkillInfo[];
    /** Skills disabled in WeaveConfig.disabled.skills. */
    disabledSkills: string[];
  }

  /** A skill successfully matched and resolved for an agent. */
  interface ResolvedSkill {
    name: string;
    content: string;
  }
  ```

- **Error types**: Discriminated union for resolution failures:
  ```ts
  type SkillResolutionError =
    | { type: "SkillNotFound"; agentName: string; skillName: string }
    | {
        type: "SkillResolutionFailed";
        agentName: string;
        errors: SkillResolutionError[];
      };
  ```
- **Relationship to `resolveAdapterModelIntent()`**: Same design pattern — pure function, explicit input, typed result. Adapters call it the same way they call model resolution.
- **`HarnessAdapter` changes**: `loadSkill()` removed, `getAvailableSkills()` added. This is a breaking interface change. The existing `SkillConfig` type in `adapter.ts` is replaced by `SkillInfo` (or removed entirely if `SkillInfo` is defined in the skill-resolution module).
- **`WeaveRunner` integration**: After `adapter.init()`, the runner calls `adapter.getAvailableSkills()`, then `resolveSkillsForConfig(config, skills)`. The resolved map is stored for prompt composition (#6) to consume later.

## Security Considerations

No specific security considerations identified. Skill content is provided by the adapter from the local harness — no credentials or sensitive data are handled by the resolution API.

## Success Metrics

1. **All unit tests pass**: Skill resolution (per-agent and batch) and runner integration tests all green
2. **Pure resolution functions**: Zero I/O, zero side effects — fully testable with plain objects
3. **Runner TODO resolved**: The skill loading placeholder in `WeaveRunner.run()` is replaced with working code
4. **Downstream unblocked**: Issue #6 (prompt composition) can consume the resolved skill map to inject skill content into agent prompts
5. **Interface corrected**: `HarnessAdapter` reflects the adapter-pushes-to-Weave pattern, consistent with model resolution

## Open Questions

1. **`SkillInfo` richness**: Should `SkillInfo` include additional metadata beyond `name` and `content` (e.g., `description`, `path`, `scope`)? For resolution purposes, `name` + `content` is sufficient, but prompt composition (#6) may want more. Starting minimal and extending later seems safe.
2. **Missing skill strictness**: Should a missing skill (agent references `"tdd"` but harness doesn't provide it) be a hard error or a warning? The spec currently treats it as an error. If adapters want softer handling, they can catch and downgrade.
3. **Disabled skill + missing skill interaction**: If a skill is both disabled and not provided by the harness, should it be silently filtered (current approach — disabled takes precedence) or should it error as missing? Current spec: disabled wins, no error.
