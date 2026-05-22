import type { AgentConfig, WeaveConfig } from "@weave/core";
import { errAsync, ResultAsync } from "neverthrow";
import type { HarnessAdapter } from "./adapter.js";
import {
  type AgentDescriptor,
  type CategoryMetadata,
  composeAgentDescriptor,
} from "./compose.js";
import {
  type CategoryShuttleConflictError,
  generateCategoryShuttles,
} from "./descriptors.js";
import { logger } from "./logger.js";
import type { RunAgentEffect } from "./run-agent-effects.js";
import { resolveSkillsForAgent } from "./skill-resolution.js";

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

export type WeaveRunnerAdapterError = {
  type: "WeaveRunnerAdapterError";
  phase: "init" | "loadAvailableSkills" | "materializeAgents";
  message: string;
  cause?: string;
};

export type WeaveRunnerError =
  | CategoryShuttleConflictError
  | WeaveRunnerAdapterError;

function toRunnerAdapterError(
  phase: WeaveRunnerAdapterError["phase"],
  cause: unknown,
): WeaveRunnerAdapterError {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  return {
    type: "WeaveRunnerAdapterError",
    phase,
    message: `Adapter failed during ${phase}`,
    cause: causeMessage,
  };
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

  /**
   * Execute the current adapter materialisation lifecycle:
   *
   * 1. Initialise the harness adapter.
   * 2. Resolve adapter-provided skill context via `loadAvailableSkills()`.
   * 3. Wire abstract lifecycle policy surfaces.     (deferred — see TODO)
   * 4. Materialise all agents that are not disabled.
   */
  run(): ResultAsync<void, WeaveRunnerError> {
    const { disabled } = this.config;

    // 1. Initialise the adapter.
    log.info("Initialising harness adapter");
    return ResultAsync.fromPromise(this.adapter.init(), (cause) =>
      toRunnerAdapterError("init", cause),
    )
      .andThen(() =>
        ResultAsync.fromPromise(this.adapter.loadAvailableSkills(), (cause) =>
          toRunnerAdapterError("loadAvailableSkills", cause),
        ),
      )
      .andThen((availableSkills) => {
        // 2. TODO(#9): wire abstract lifecycle policy surfaces.
        // The execution lifecycle surface (execution-lifecycle.ts) provides 7 typed
        // engine functions that adapters call after mapping concrete harness events:
        //   observeSession, startExecution, resumeExecution, handleUserInterrupt,
        //   dispatchStep, completeStep, beforeTool.
        // These supersede registerHook(). Full workflow engine integration is deferred
        // to a future spec; the runner currently handles only agent materialisation.

        // Compatibility note: `materializeAgents()` is the preferred adapter-facing
        // pure materialization API, but this transitional runner intentionally keeps
        // the existing manual loop. `WeaveRunner.run()` returns typed category shuttle
        // conflict errors and continues after descriptor composition failures so later
        // agents can still spawn. `materializeAgents()` stops on the first descriptor
        // composition failure. A future runner refactor must either add partial-failure
        // materialization support or explicitly convert those typed results back into
        // the runner's observable skip-and-continue behavior before replacing this
        // code path.

        const shuttlesResult = generateCategoryShuttles(this.config);
        if (shuttlesResult.isErr()) {
          const conflict = shuttlesResult.error;
          log.error(
            { conflict: conflict.shuttleName, category: conflict.categoryName },
            conflict.message,
          );
          return errAsync(conflict);
        }

        const allAgents: Record<string, AgentConfig> = {
          ...this.config.agents,
        };
        const categoryMetaMap: Record<string, CategoryMetadata> = {};

        for (const [name, generated] of Object.entries(shuttlesResult.value)) {
          allAgents[name] = generated.config;
          categoryMetaMap[name] = generated.categoryMeta;
        }

        // 3. Resolve skills from adapter-provided SkillInfo values.
        // Skill discovery/loading is adapter-owned; the engine only matches agent
        // skill references against explicit harness context and disabled.skills.
        // Resolve per agent so one missing skill cannot wipe successful entries
        // for other agents. Agents with resolution errors simply receive the
        // materialization default of an empty resolvedSkills array.
        const resolvedSkillsMap: Record<string, readonly string[]> = {};
        for (const [agentName, agentConfig] of Object.entries(allAgents) as [
          string,
          AgentConfig,
        ][]) {
          if (disabled.agents.includes(agentName)) continue;

          const skillResolutionResult = resolveSkillsForAgent({
            agentName,
            agentSkills: agentConfig.skills,
            availableSkills,
            disabledSkills: this.config.disabled.skills,
          });

          if (skillResolutionResult.isOk()) {
            resolvedSkillsMap[agentName] = skillResolutionResult.value.map(
              (s) => s.name,
            );
            continue;
          }

          for (const error of skillResolutionResult.error) {
            log.warn(
              { agent: error.agentName, skill: error.skillName },
              "Skill declared by agent is not available in harness",
            );
          }
        }

        return ResultAsync.fromPromise(
          this.materializeAgents(
            disabled,
            allAgents,
            categoryMetaMap,
            resolvedSkillsMap,
          ),
          (cause) => toRunnerAdapterError("materializeAgents", cause),
        );
      });
  }

  private async materializeAgents(
    disabled: WeaveConfig["disabled"],
    allAgents: Record<string, AgentConfig>,
    categoryMetaMap: Record<string, CategoryMetadata>,
    resolvedSkillsMap: Record<string, readonly string[]>,
  ): Promise<void> {
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
        categoryMetaMap[name],
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
