import type { AgentConfig } from "./agent.js";
import type { HookConfig } from "./hook.js";
import type { SkillConfig } from "./skill.js";

/**
 * Top-level Weave configuration shape.
 *
 * This is the root object parsed from a `weave.config.ts` (or equivalent)
 * file. It describes all agents, hooks, skills, and any disabled items for
 * the current workspace.
 */
export interface WeaveConfig {
	/**
	 * Map of agent identifier → agent configuration.
	 * The key is used as the logical agent name when spawning sub-agents.
	 *
	 * @example
	 * agents: {
	 *   coder: { name: "coder", model: "claude-sonnet-4-5", ... }
	 * }
	 */
	agents: Record<string, AgentConfig>;

	/**
	 * Ordered list of hook configurations that will be registered with the
	 * underlying harness adapter at startup.
	 */
	hooks: HookConfig[];

	/**
	 * List of skills to make available to agents in this workspace.
	 */
	skills: SkillConfig[];

	/**
	 * Names of agents, hooks, or skills that should be disabled at runtime.
	 * Items in this list are parsed but never activated.
	 */
	disabled?: string[];
}
