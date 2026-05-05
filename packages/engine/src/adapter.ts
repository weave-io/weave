import type { AgentConfig, HookConfig, SkillConfig } from "@weave/core";

/**
 * The `HarnessAdapter` interface abstracts all harness-specific operations
 * behind a uniform contract. Each supported agent harness (OpenCode,
 * Claude Code, Pi, …) ships its own implementation of this interface.
 *
 * The `WeaveRunner` depends only on this interface, keeping the core
 * orchestration logic fully harness-agnostic.
 */
export interface HarnessAdapter {
	/**
	 * Perform any one-time initialisation required by the harness before
	 * agents can be spawned. Called exactly once by `WeaveRunner.run()`
	 * before any other adapter method.
	 */
	init(): Promise<void>;

	/**
	 * Spawn a new sub-agent with the provided configuration.
	 *
	 * @param name   - Logical agent name (key from `WeaveConfig.agents`).
	 * @param config - Full agent configuration to apply to the spawned agent.
	 */
	spawnSubagent(name: string, config: AgentConfig): Promise<void>;

	/**
	 * Register a lifecycle hook with the harness so that it fires at the
	 * appropriate point in the agent's execution lifecycle.
	 *
	 * @param hook - The hook configuration to register.
	 */
	registerHook(hook: HookConfig): Promise<void>;

	/**
	 * Load a skill into the harness so that it becomes available to any
	 * agent that references it in its `AgentConfig.skills` list.
	 *
	 * @param skill - The skill configuration to load.
	 */
	loadSkill(skill: SkillConfig): Promise<void>;
}
