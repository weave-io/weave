/**
 * Adapter-Provided Skill Resolution — public engine types.
 *
 * This module defines the engine-owned vocabulary for skill resolution:
 * - `SkillInfo`   — adapter-supplied descriptor; `name` is the only engine-required field.
 * - `ResolvedSkill` — a skill selected for a specific agent after filtering.
 * - `SkillResolutionInput` — explicit input for single-agent resolution.
 * - `SkillResolutionConfigInput` — explicit input for config-wide resolution.
 * - `SkillResolutionError` — discriminated error union for missing non-disabled skills.
 *
 * Design principles (Spec 09, Unit 1 & 3):
 * - Engine owns only `name` as the stable matching key.
 * - All other metadata is adapter-owned pass-through; the engine never inspects it.
 * - No harness-specific references: no OpenCode, Claude Code, Pi, Bun.file, or process-spawning.
 * - All fallible paths return `Result<T, E>` from `neverthrow`.
 *
 * @see docs/specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md
 */

import type { WeaveConfig } from "@weave/core";
import { err, ok, type Result } from "neverthrow";
import { generateCategoryShuttles } from "./descriptors.js";

// ---------------------------------------------------------------------------
// SkillInfo — adapter-supplied descriptor
// ---------------------------------------------------------------------------

/**
 * A skill descriptor supplied by an adapter or harness.
 *
 * `name` is the only engine-required field and is the stable key used to match
 * `AgentConfig.skills` entries. All other fields are adapter-owned pass-through
 * metadata; the engine never reads or validates them.
 *
 * Adapters may extend this type with harness-specific fields (e.g. file paths,
 * scope, content, mounting details) by passing them through the `metadata`
 * field or by using a subtype. The engine will preserve but never inspect them.
 */
export interface SkillInfo {
  /** Stable matching key — the only field the engine uses for resolution. */
  name: string;
  /**
   * Adapter-owned pass-through metadata.
   *
   * The engine preserves this value in `ResolvedSkill` but never reads,
   * validates, or logs its contents. Adapters may store file paths, scope
   * labels, content hashes, mounting details, or any other harness-specific
   * data here.
   */
  metadata?: unknown;
}

// ---------------------------------------------------------------------------
// ResolvedSkill — a skill selected for a specific agent
// ---------------------------------------------------------------------------

/**
 * A skill that has been matched and selected for a specific agent after
 * disabled-skill filtering and availability checks.
 *
 * The engine populates `name` and preserves the adapter-supplied `skillInfo`
 * so adapters can use their own metadata to mount or apply the skill without
 * requiring the engine to understand harness-specific details.
 */
export interface ResolvedSkill {
  /** The resolved skill name, matching `SkillInfo.name`. */
  name: string;
  /**
   * The original adapter-supplied descriptor for this skill.
   *
   * Adapters may read any harness-specific fields they placed in `SkillInfo`
   * from this reference. The engine never inspects it beyond the initial
   * name-matching step.
   */
  skillInfo: SkillInfo;
}

// ---------------------------------------------------------------------------
// SkillResolutionError — discriminated error union
// ---------------------------------------------------------------------------

/**
 * A missing non-disabled skill error.
 *
 * Emitted when an agent's `skills [...]` declaration references a skill name
 * that is neither present in the adapter-provided `availableSkills` list nor
 * suppressed by `disabledSkills`.
 *
 * Fields are intentionally minimal: only the agent name and skill name are
 * included. Engine errors must not expose adapter-owned file paths, skill
 * contents, API keys, tokens, or harness-private mounting details.
 */
export type SkillResolutionError = {
  type: "MissingSkill";
  /** The logical agent name from the normalized Weave config. */
  agentName: string;
  /** The skill name that could not be resolved. */
  skillName: string;
};

// ---------------------------------------------------------------------------
// SkillResolutionInput — explicit input for single-agent resolution
// ---------------------------------------------------------------------------

/**
 * Explicit input for `resolveSkillsForAgent()`.
 *
 * All harness context is adapter-provided; the engine performs no discovery.
 */
export interface SkillResolutionInput {
  /** Logical agent name from the normalized Weave config. */
  agentName: string;
  /**
   * Skill names declared in the agent's `skills [...]` field.
   * `undefined` or empty array → returns `ok([])`.
   */
  agentSkills?: string[];
  /**
   * Adapter-provided list of skills available in the harness.
   * The engine matches `agentSkills` entries against `SkillInfo.name` values.
   */
  availableSkills: SkillInfo[];
  /**
   * Skill names that are globally or project-level disabled.
   * Matches against `config.disabled.skills`.
   * Disabled requested skills are silently filtered — no missing-skill error.
   */
  disabledSkills?: string[];
}

// ---------------------------------------------------------------------------
// resolveSkillsForAgent — pure single-agent resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve one agent's declared skill names against adapter-provided available skills.
 *
 * Resolution rules (in order):
 * 1. If `agentSkills` is undefined or empty, return `ok([])`.
 * 2. For each requested skill name:
 *    a. If the name appears in `disabledSkills`, skip it silently.
 *    b. If the name matches an entry in `availableSkills` by exact `name`, include it.
 *    c. Otherwise, record a `MissingSkill` error.
 * 3. If any missing-skill errors were recorded, return `err(errors)`.
 * 4. Otherwise, return `ok(resolvedSkills)` in declaration order.
 *
 * This function is pure and side-effect free. It performs no filesystem access,
 * harness API calls, or adapter-owned discovery.
 */
export function resolveSkillsForAgent(
  input: SkillResolutionInput,
): Result<ResolvedSkill[], SkillResolutionError[]> {
  const {
    agentName,
    agentSkills,
    availableSkills,
    disabledSkills = [],
  } = input;

  if (agentSkills === undefined || agentSkills.length === 0) {
    return ok([]);
  }

  const availableByName = new Map<string, SkillInfo>(
    availableSkills.map((s) => [s.name, s]),
  );

  const resolved: ResolvedSkill[] = [];
  const errors: SkillResolutionError[] = [];

  for (const skillName of agentSkills) {
    if (disabledSkills.includes(skillName)) continue;

    const skillInfo = availableByName.get(skillName);
    if (skillInfo !== undefined) {
      resolved.push({ name: skillName, skillInfo });
      continue;
    }

    errors.push({ type: "MissingSkill", agentName, skillName });
  }

  if (errors.length > 0) return err(errors);
  return ok(resolved);
}

// ---------------------------------------------------------------------------
// SkillResolutionConfigInput — explicit input for config-wide resolution
// ---------------------------------------------------------------------------

/**
 * Explicit input for `resolveSkillsForConfig()`.
 *
 * All harness context is adapter-provided; the engine performs no discovery.
 * The engine reads `config.agents`, `config.categories`, and
 * `config.disabled.skills` from the provided `WeaveConfig`.
 */
export interface SkillResolutionConfigInput {
  /**
   * The normalized Weave config. The engine reads `config.agents`,
   * `config.categories`, and `config.disabled.skills` from this value.
   */
  config: WeaveConfig;
  /**
   * Adapter-provided list of skills available in the harness.
   * The engine matches each agent's `skills [...]` entries against
   * `SkillInfo.name` values in this list.
   */
  availableSkills: SkillInfo[];
}

// ---------------------------------------------------------------------------
// ConfigSkillResolutionResult — batch result keyed by agent name
// ---------------------------------------------------------------------------

/**
 * The successful result of `resolveSkillsForConfig()`.
 *
 * A record keyed by stable agent name (e.g. `"loom"`, `"shuttle-backend"`)
 * mapping to the resolved skills for that agent. Agents with no `skills`
 * declaration are included with an empty array.
 */
export type ConfigSkillResolutionResult = Record<string, ResolvedSkill[]>;

// ---------------------------------------------------------------------------
// resolveSkillsForConfig — config-wide batch resolution
// ---------------------------------------------------------------------------

/**
 * Resolve skills for all agents in the normalized Weave config, including
 * generated category shuttle descriptors.
 *
 * Resolution rules:
 * 1. Collect all declared agents from `config.agents`.
 * 2. Generate category shuttle descriptors via `generateCategoryShuttles(config)`.
 *    - If shuttle generation returns a conflict error, propagate it as a
 *      `SkillResolutionError` with `agentName: shuttleName` and
 *      `skillName: "__category_shuttle_conflict__"`.
 * 3. For each agent (declared + generated), call `resolveSkillsForAgent` with
 *    `config.disabled.skills` as the disabled list.
 * 4. Accumulate all `MissingSkill` errors across all agents.
 * 5. If any errors were accumulated, return `err(allErrors)`.
 * 6. Otherwise, return `ok(result)` where `result` is a record keyed by
 *    agent name with the resolved skills for each agent.
 *
 * Disabled agents (in `config.disabled.agents`) are excluded from resolution
 * entirely — consistent with `generateCategoryShuttles` which already skips
 * disabled generated shuttles.
 *
 * This function is pure and side-effect free. It performs no filesystem access,
 * harness API calls, or adapter-owned discovery.
 */
export function resolveSkillsForConfig(
  input: SkillResolutionConfigInput,
): Result<ConfigSkillResolutionResult, SkillResolutionError[]> {
  const { config, availableSkills } = input;
  const disabledSkills = config.disabled.skills;
  const disabledAgents = config.disabled.agents;

  // Collect declared agents, skipping disabled ones
  const agentEntries: Array<[string, string[] | undefined]> = [];
  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    if (disabledAgents.includes(agentName)) continue;
    agentEntries.push([agentName, agentConfig.skills]);
  }

  // Generate category shuttle descriptors — reuse existing semantics
  const shuttlesResult = generateCategoryShuttles(config);
  if (shuttlesResult.isErr()) {
    // Propagate conflict as a typed error
    const conflict = shuttlesResult.error;
    return err([
      {
        type: "MissingSkill",
        agentName: conflict.shuttleName,
        skillName: "__category_shuttle_conflict__",
      },
    ]);
  }

  // Add generated shuttles (generateCategoryShuttles already skips disabled ones)
  for (const [shuttleName, generated] of Object.entries(shuttlesResult.value)) {
    agentEntries.push([shuttleName, generated.config.skills]);
  }

  // Resolve skills for each agent, accumulating all errors
  const result: ConfigSkillResolutionResult = {};
  const allErrors: SkillResolutionError[] = [];

  for (const [agentName, agentSkills] of agentEntries) {
    const agentResult = resolveSkillsForAgent({
      agentName,
      agentSkills,
      availableSkills,
      disabledSkills,
    });

    if (agentResult.isErr()) {
      allErrors.push(...agentResult.error);
      continue;
    }

    result[agentName] = agentResult.value;
  }

  if (allErrors.length > 0) return err(allErrors);
  return ok(result);
}
