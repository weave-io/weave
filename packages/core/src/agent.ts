/**
 * Configuration for a single agent managed by Weave.
 */
export interface AgentConfig {
	/**
	 * Logical name of the agent. Must be unique within a `WeaveConfig.agents`
	 * map and is used to identify the agent when spawning sub-agents.
	 */
	name: string;

	/**
	 * The model identifier to use for this agent.
	 *
	 * @example "claude-sonnet-4-5", "gpt-4o", "gemini-2-flash"
	 */
	model?: string;

	/**
	 * Sampling temperature between 0 and 1. Lower values produce more
	 * deterministic output; higher values increase creativity.
	 *
	 * @default 0.5
	 */
	temperature?: number;

	/**
	 * List of tool names that this agent is permitted to use.
	 * When omitted the harness adapter's default tool set is used.
	 *
	 * @example ["read", "edit", "bash", "web_search"]
	 */
	tools?: string[];

	/**
	 * Names of skills (referencing `WeaveConfig.skills`) that should be
	 * loaded for this agent.
	 */
	skills?: string[];

	/**
	 * Additional text appended to this agent's system prompt at runtime.
	 * Useful for injecting persona-specific or task-specific instructions
	 * without replacing the harness-provided system prompt.
	 */
	prompt_append?: string;
}
