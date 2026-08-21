/**
 * Adapter-provided skill resolution.
 *
 * The engine matches agent skill names against an adapter-provided catalog.
 * Missing skills are warnings because harness catalogs can differ. Disabled
 * skills are filtered silently.
 *
 * @see docs/architecture/adapter-boundary.md
 */

import type { WeaveConfig } from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";
import type { CategoryShuttleConflictError } from "./descriptors.js";
import { generateCategoryShuttles } from "./descriptors.js";

/** A harness skill descriptor. The engine matches only on `name`. */
export interface SkillInfo {
  readonly name: string;
  /** Opaque adapter-owned data preserved for the adapter. */
  readonly metadata?: unknown;
}

/** A requested skill matched against the harness catalog. */
export interface ResolvedSkill {
  readonly name: string;
  readonly skillInfo: SkillInfo;
}

/** A non-fatal warning for a requested skill absent from the harness catalog. */
export type SkillResolutionWarning = {
  readonly type: "MissingSkill";
  readonly agentName: string;
  readonly skillName: string;
};

/** @deprecated Use `SkillResolutionWarning`. Missing skills do not fail resolution. */
export type SkillResolutionError = SkillResolutionWarning;

/** The complete result for one agent, including partial resolution warnings. */
export interface SkillResolutionResult {
  readonly resolvedSkills: ResolvedSkill[];
  readonly warnings: SkillResolutionWarning[];
}

export interface SkillResolutionInput {
  readonly agentName: string;
  readonly agentSkills?: string[];
  readonly availableSkills: SkillInfo[];
  readonly disabledSkills?: string[];
}

/**
 * Resolves one agent's requested skills in declaration order.
 *
 * Available skills are returned for adapter-side loading. Missing skills emit
 * warnings and do not discard available skills or fail activation. Disabled
 * requested skills are omitted without a warning.
 */
export function resolveSkillsForAgent(
  input: SkillResolutionInput,
): Result<SkillResolutionResult, never> {
  const {
    agentName,
    agentSkills = [],
    availableSkills,
    disabledSkills = [],
  } = input;
  const availableByName = new Map(
    availableSkills.map((skill) => [skill.name, skill]),
  );
  const disabled = new Set(disabledSkills);
  const seen = new Set<string>();
  const resolvedSkills: ResolvedSkill[] = [];
  const warnings: SkillResolutionWarning[] = [];

  for (const skillName of agentSkills) {
    if (seen.has(skillName)) continue;
    seen.add(skillName);
    if (disabled.has(skillName)) continue;

    const skillInfo = availableByName.get(skillName);
    if (skillInfo === undefined) {
      warnings.push({ type: "MissingSkill", agentName, skillName });
      continue;
    }

    resolvedSkills.push({ name: skillName, skillInfo });
  }

  return ok({ resolvedSkills, warnings });
}

export interface SkillResolutionConfigInput {
  readonly config: WeaveConfig;
  readonly availableSkills: SkillInfo[];
}

/** The complete skill result for all enabled declared and generated agents. */
export interface ConfigSkillResolutionResult {
  readonly skillsByAgent: Record<string, ResolvedSkill[]>;
  readonly warnings: SkillResolutionWarning[];
}

/**
 * Resolves skills for every enabled agent and generated category shuttle.
 *
 * Missing skills are accumulated as warnings. Category shuttle name conflicts
 * remain errors because they prevent an unambiguous agent inventory.
 */
export function resolveSkillsForConfig(
  input: SkillResolutionConfigInput,
): Result<ConfigSkillResolutionResult, CategoryShuttleConflictError> {
  const { config, availableSkills } = input;
  const agentEntries: Array<[string, string[] | undefined]> = [];

  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    if (config.disabled.agents.includes(agentName)) continue;
    agentEntries.push([agentName, agentConfig.skills]);
  }

  const shuttlesResult = generateCategoryShuttles(config);
  if (shuttlesResult.isErr()) return err(shuttlesResult.error);

  for (const [shuttleName, generated] of Object.entries(shuttlesResult.value)) {
    agentEntries.push([shuttleName, generated.config.skills]);
  }

  const skillsByAgent: Record<string, ResolvedSkill[]> = {};
  const warnings: SkillResolutionWarning[] = [];

  for (const [agentName, agentSkills] of agentEntries) {
    const resolution = resolveSkillsForAgent({
      agentName,
      agentSkills,
      availableSkills,
      disabledSkills: config.disabled.skills,
    }).match(
      (value) => value,
      (impossible) => impossible,
    );
    skillsByAgent[agentName] = resolution.resolvedSkills;
    warnings.push(...resolution.warnings);
  }

  return ok({ skillsByAgent, warnings });
}
