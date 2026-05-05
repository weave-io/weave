/**
 * Scope controls where a skill is sourced from and how it is resolved.
 *
 * - `builtin`  — shipped with the harness adapter
 * - `user`     — defined in the user's global agent configuration directory
 * - `project`  — defined relative to the current project root
 */
export type SkillScope = "builtin" | "user" | "project";

/**
 * Configuration for a single skill that can be attached to one or more
 * agents via `AgentConfig.skills`.
 */
export interface SkillConfig {
	/**
	 * Unique name of the skill. Referenced by `AgentConfig.skills` and
	 * `WeaveConfig.disabled`.
	 */
	name: string;

	/**
	 * File-system path or identifier used by the harness adapter to locate
	 * and load the skill definition.
	 *
	 * - For `builtin` skills this is typically the skill's registry key.
	 * - For `user` and `project` skills this is a path relative to the
	 *   skill's scope root.
	 *
	 * @example "./skills/tdd"
	 */
	path: string;

	/**
	 * Resolution scope for this skill.
	 *
	 * @default "project"
	 */
	scope: SkillScope;
}
