import type { AgentConfig, WeaveConfig } from "@weave/core";
import type { HarnessAdapter } from "./adapter.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "runner" });

/**
 * `WeaveRunner` is the central orchestrator of the Weave engine.
 *
 * It accepts a parsed `WeaveConfig` and a harness-specific `HarnessAdapter`,
 * then drives the full agent lifecycle: initialising the adapter, loading
 * skills, registering hooks, and spawning configured agents.
 *
 * @example
 * ```ts
 * import { WeaveRunner } from "@weave/engine";
 * import { PiAdapter } from "@weave/adapter-pi";
 * import config from "./weave.config.js";
 *
 * const runner = new WeaveRunner(config, new PiAdapter());
 * await runner.run();
 * ```
 */
export class WeaveRunner {
	private readonly config: WeaveConfig;
	private readonly adapter: HarnessAdapter;

	constructor(config: WeaveConfig, adapter: HarnessAdapter) {
		this.config = config;
		this.adapter = adapter;
	}

	/**
	 * Execute the full Weave orchestration lifecycle:
	 *
	 * 1. Initialise the harness adapter.
	 * 2. Load all skills that are not disabled.
	 * 3. Register all enabled hooks.
	 * 4. Spawn all agents that are not disabled.
	 */
	async run(): Promise<void> {
		const { agents, hooks, skills, disabled = [] } = this.config;

		// 1. Initialise the adapter.
		log.info("Initialising harness adapter");
		await this.adapter.init();

		// 2. Load skills (skip any that appear in the disabled list).
		for (const skill of skills) {
			if (disabled.includes(skill.name)) {
				log.debug({ skill: skill.name }, "Skipping disabled skill");
				continue;
			}
			log.info({ skill: skill.name, scope: skill.scope }, "Loading skill");
			await this.adapter.loadSkill(skill);
		}

		// 3. Register enabled hooks (skip disabled ones).
		for (const hook of hooks) {
			if (!hook.enabled || disabled.includes(hook.name)) {
				log.debug({ hook: hook.name }, "Skipping disabled hook");
				continue;
			}
			log.info({ hook: hook.name }, "Registering hook");
			await this.adapter.registerHook(hook);
		}

		// 4. Spawn agents (skip any that appear in the disabled list).
		for (const [name, agentConfig] of Object.entries(agents) as [
			string,
			AgentConfig,
		][]) {
			if (disabled.includes(name)) {
				log.debug({ agent: name }, "Skipping disabled agent");
				continue;
			}
			log.info({ agent: name, model: agentConfig.model }, "Spawning agent");
			await this.adapter.spawnSubagent(name, agentConfig);
		}

		log.info("Weave run complete");
	}
}
