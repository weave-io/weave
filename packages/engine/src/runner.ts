import type { AgentConfig, WeaveConfig } from "@weave/core";
import type { HarnessAdapter } from "./adapter.js";
import { generateCategoryShuttles } from "./descriptors.js";
import { logger } from "./logger.js";
import type { RunAgentEffect } from "./run-agent-effects.js";
import { evaluateEffectiveToolPolicy } from "./tool-policy.js";

const log = logger.child({ module: "runner" });

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Optional configuration for `WeaveRunner`.
 *
 * All fields are optional — existing callers that construct `WeaveRunner`
 * without an options object continue to work unchanged.
 */
export interface WeaveRunnerOptions {
  /**
   * Called once per agent immediately before `adapter.spawnSubagent`.
   *
   * Receives a `RunAgentEffect` carrying the engine-computed
   * `effectiveToolPolicy` (all five capabilities resolved) and the raw
   * `rawToolPolicy` (the agent's declared `tool_policy`, or `undefined`).
   *
   * The callback is synchronous and must not throw. Errors inside the
   * callback are the caller's responsibility.
   */
  onEffect?: (effect: RunAgentEffect) => void;
}

// ---------------------------------------------------------------------------
// WeaveRunner
// ---------------------------------------------------------------------------

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
 *
 * @example With effect observation:
 * ```ts
 * const runner = new WeaveRunner(config, new PiAdapter(), {
 *   onEffect(effect) {
 *     if (effect.kind === "run-agent") {
 *       console.log(effect.agentName, effect.effectiveToolPolicy);
 *     }
 *   },
 * });
 * await runner.run();
 * ```
 */
export class WeaveRunner {
  private readonly config: WeaveConfig;
  private readonly adapter: HarnessAdapter;
  private readonly options: WeaveRunnerOptions;

  constructor(
    config: WeaveConfig,
    adapter: HarnessAdapter,
    options: WeaveRunnerOptions = {},
  ) {
    this.config = config;
    this.adapter = adapter;
    this.options = options;
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

      // Evaluate the effective tool policy for this agent and emit an effect
      // before delegating to the adapter. The raw tool_policy is passed to the
      // adapter unchanged so adapters can apply harness-specific translation.
      const effectiveToolPolicy = evaluateEffectiveToolPolicy(
        agentConfig.tool_policy,
      );

      this.options.onEffect?.({
        kind: "run-agent",
        agentName: name,
        effectiveToolPolicy,
        rawToolPolicy: agentConfig.tool_policy,
      });

      log.info(
        { agent: name, model: agentConfig.models?.[0] },
        "Spawning agent",
      );
      await this.adapter.spawnSubagent(name, agentConfig);
    }

    log.info("Weave run complete");
  }
}
