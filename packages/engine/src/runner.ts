import type { AgentConfig, WeaveConfig } from "@weave/core";
import type { HarnessAdapter } from "./adapter.js";
import { type AgentDescriptor, composeAgentDescriptor } from "./compose.js";
import { generateCategoryShuttles } from "./descriptors.js";
import { logger } from "./logger.js";
import type { RunAgentEffect } from "./run-agent-effects.js";
import { resolveSkillsForConfig } from "./skill-resolution.js";
import type { CategoryInput } from "./template-context.js";

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
   * `effectiveToolPolicy` (all five capabilities resolved), the raw
   * `rawToolPolicy` (the agent's declared `tool_policy`, or `undefined`),
   * and `resolvedSkills` (ordered list of resolved skill names for this agent).
   *
   * The callback is synchronous. If it throws, the error is logged and
   * agent materialization continues uninterrupted.
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
 *       log.info({ agent: effect.agentName, policy: effect.effectiveToolPolicy }, "Agent effect");
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

  private categoryForGeneratedShuttle(name: string): CategoryInput | undefined {
    if (!name.startsWith("shuttle-")) return undefined;

    const categoryName = name.slice("shuttle-".length);
    const category = this.config.categories[categoryName];
    if (category === undefined) return undefined;

    return {
      name: categoryName,
      description: category.description,
      patterns: category.patterns,
    };
  }

  /**
   * Execute the current adapter materialisation lifecycle:
   *
   * 1. Initialise the harness adapter.
   * 2. Resolve adapter-provided skill context via `loadAvailableSkills()`.
   * 3. Wire abstract lifecycle policy surfaces.     (deferred — see TODO)
   * 4. Materialise all agents that are not disabled.
   */
  async run(): Promise<void> {
    const { disabled } = this.config;

    // 1. Initialise the adapter.
    log.info("Initialising harness adapter");
    await this.adapter.init();

    // 2. Resolve skills from adapter-provided SkillInfo values.
    // Skill discovery/loading is adapter-owned; the engine only matches agent
    // skill references against explicit harness context and disabled.skills.
    const availableSkills = await this.adapter.loadAvailableSkills();
    const skillResolutionResult = resolveSkillsForConfig({
      config: this.config,
      availableSkills,
    });

    // Log any missing-skill errors but do not abort — adapters may handle
    // partial resolution gracefully. The resolved map defaults to empty arrays
    // for agents with no skills or resolution errors.
    const resolvedSkillsMap: Record<string, readonly string[]> = {};
    if (skillResolutionResult.isOk()) {
      for (const [agentName, skills] of Object.entries(
        skillResolutionResult.value,
      )) {
        resolvedSkillsMap[agentName] = skills.map((s) => s.name);
      }
    } else {
      for (const error of skillResolutionResult.error) {
        log.warn(
          { agent: error.agentName, skill: error.skillName },
          "Skill declared by agent is not available in harness",
        );
      }
    }

    // 3. TODO(#9): wire abstract lifecycle policy surfaces.
    // The execution lifecycle surface (execution-lifecycle.ts) provides 7 typed
    // engine functions that adapters call after mapping concrete harness events:
    //   observeSession, startExecution, resumeExecution, handleUserInterrupt,
    //   dispatchStep, completeStep, beforeTool.
    // These supersede registerHook(). Full workflow engine integration is deferred
    // to a future spec; the runner currently handles only agent materialisation.

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

      const descriptorResult = await composeAgentDescriptor(
        name,
        agentConfig,
        this.config,
        allAgents,
        this.categoryForGeneratedShuttle(name),
      );

      if (descriptorResult.isErr()) {
        log.error(
          { agent: name, error: descriptorResult.error },
          "Failed to compose agent descriptor; skipping agent",
        );
        continue;
      }

      const descriptor: AgentDescriptor = descriptorResult.value;
      // Resolved skill names for this agent — only names, no adapter metadata.
      const resolvedSkills: readonly string[] = resolvedSkillsMap[name] ?? [];

      try {
        this.options.onEffect?.({
          kind: "run-agent",
          agentName: name,
          agentDescriptor: descriptor,
          effectiveToolPolicy: descriptor.effectiveToolPolicy,
          rawToolPolicy: descriptor.rawToolPolicy,
          resolvedSkills,
        });
      } catch (error) {
        log.warn(
          { agent: name, error },
          "onEffect callback threw; continuing agent materialization",
        );
      }

      log.info({ agent: name, model: descriptor.models[0] }, "Spawning agent");
      await this.adapter.spawnSubagent(descriptor);
    }

    log.info("Weave run complete");
  }
}
