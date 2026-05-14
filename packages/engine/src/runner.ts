import type { AgentConfig, WeaveConfig } from "@weave/core";
import type { HarnessAdapter } from "./adapter.js";
import { composeAgentDescriptor } from "./compose.js";
import { generateCategoryShuttles } from "./descriptors.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "runner" });

/**
 * `WeaveRunner` is the current transitional orchestration entry point for the
 * Weave engine.
 *
 * It accepts a parsed `WeaveConfig` and a harness-specific `HarnessAdapter`,
 * then passes normalized Weave intent through the adapter boundary. It must not
 * discover harness-owned resources (skills, available models, selected model
 * state) or register concrete harness callbacks directly; adapters own those
 * details and provide explicit context to engine composition APIs.
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
   * Execute the current adapter materialisation lifecycle:
   *
   * 1. Initialise the harness adapter.
   * 2. Resolve adapter-provided skill context.      (deferred — see TODO)
   * 3. Wire abstract lifecycle policy surfaces.     (deferred — see TODO)
   * 4. Materialise all agents that are not disabled.
   */
  async run(): Promise<void> {
    const { disabled } = this.config;

    // 1. Initialise the adapter.
    log.info("Initialising harness adapter");
    await this.adapter.init();

    // 2. TODO(#12): resolve skills from adapter-provided SkillInfo values.
    // Skill discovery/loading is adapter-owned; the engine only matches agent
    // skill references against explicit harness context and disabled.skills.

    // 3. TODO(#9): wire abstract lifecycle policy surfaces.
    // Concrete hook registration is adapter-owned; adapters map harness events
    // into engine policy handlers.

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

    // 4. Materialise agents through the adapter boundary (skip disabled).
    for (const [name, agentConfig] of Object.entries(allAgents) as [
      string,
      AgentConfig,
    ][]) {
      if (disabled.agents.includes(name)) {
        log.debug({ agent: name }, "Skipping disabled agent");
        continue;
      }
      // SPIKE: compose descriptors in the runner before adapter handoff.
      const descriptorResult = await composeAgentDescriptor(
        name,
        agentConfig,
        this.config,
      );

      if (descriptorResult.isErr()) {
        const error = descriptorResult.error;
        log.error({ agent: name, error }, error.message);
        continue;
      }

      const descriptor = descriptorResult.value;
      log.info({ agent: name, model: descriptor.models[0] }, "Spawning agent");
      await this.adapter.spawnSubagent(name, descriptor);
    }

    log.info("Weave run complete");
  }
}
