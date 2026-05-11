import type { AgentConfig, WeaveConfig } from "@weave/core";
import type { HarnessAdapter } from "./adapter.js";
import { generateCategoryShuttles } from "./descriptors.js";
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
   * 2. Load all skills that are not disabled.  (deferred — see TODO)
   * 3. Register all enabled hooks.             (deferred — see TODO)
   * 4. Spawn all agents that are not disabled.
   */
  async run(): Promise<void> {
    const { disabled } = this.config;

    // 1. Initialise the adapter.
    log.info("Initialising harness adapter");
    await this.adapter.init();

    // 2. TODO: restore skill loading when skill config surfaces are specced.
    // Skills are referenced by name in agent config but full SkillConfig
    // (path, scope) is an engine concern not yet part of the .weave DSL spec.

    // 3. TODO: restore hook registration when hook config surfaces are specced.
    // Hooks are not part of the .weave DSL spec in @weave/core at this time.

    const shuttlesResult = generateCategoryShuttles(this.config);
    if (shuttlesResult.isErr()) {
      const conflict = shuttlesResult.error;
      log.error(
        { conflict: conflict.shuttleName, category: conflict.categoryName },
        conflict.message,
      );
      throw new Error(conflict.message);
    }

    const allAgents: Record<string, AgentConfig> = {
      ...this.config.agents,
      ...shuttlesResult.value,
    };

    // 4. Spawn agents (skip any that appear in the disabled.agents list).
    for (const [name, agentConfig] of Object.entries(allAgents) as [
      string,
      AgentConfig,
    ][]) {
      if (disabled.agents.includes(name)) {
        log.debug({ agent: name }, "Skipping disabled agent");
        continue;
      }
      log.info(
        { agent: name, model: agentConfig.models?.[0] },
        "Spawning agent",
      );
      await this.adapter.spawnSubagent(name, agentConfig);
    }

    log.info("Weave run complete");
  }
}
