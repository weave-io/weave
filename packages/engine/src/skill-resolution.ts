/**
 * Adapter-Provided Skill Resolution — public engine types.
 *
 * This module defines the engine-owned vocabulary for skill resolution:
 * - `SkillInfo`   — adapter-supplied descriptor; `name` is the only engine-required field.
 * - `ResolvedSkill` — a skill selected for a specific agent after filtering.
 * - `SkillResolutionInput` — explicit input for single-agent resolution.
 * - `SkillResolutionError` — discriminated error union for missing non-disabled skills.
 *
 * Design principles (Spec 09, Unit 1):
 * - Engine owns only `name` as the stable matching key.
 * - All other metadata is adapter-owned pass-through; the engine never inspects it.
 * - No harness-specific references: no OpenCode, Claude Code, Pi, Bun.file, or process-spawning.
 * - All fallible paths return `Result<T, E>` from `neverthrow`.
 *
 * @see docs/specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md
 */

import { err, ok, type Result } from "neverthrow";

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
