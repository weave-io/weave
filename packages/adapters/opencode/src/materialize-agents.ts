/**
 * Turns a resolved Weave config into the agent configs OpenCode V1 is given,
 * and tells the engine which of them OpenCode actually holds.
 *
 * The engine composes every descriptor, and it leaves out of Loom's and
 * Tapestry's delegation lists any agent whose own descriptor failed to
 * compose. What it cannot know is whether this adapter then refused an agent:
 * a model that does not resolve, or a descriptor that does not translate. So
 * the adapter reports what it registered, and when it refused anything the
 * engine composes once more with that report, so no router is offered an
 * agent OpenCode does not hold. See
 * [ADR 0013](../../../../docs/adr/0013-delegation-targets-from-materialized-agents.md).
 */

import type { WeaveConfig } from "@weaveio/weave-core";
import {
  materializeAgents as engineMaterializeAgents,
  type HarnessMaterializationReport,
  logger,
  type MaterializationPlan,
  type UnavailableAgent,
} from "@weaveio/weave-engine";

import { resolveModelForAgent } from "./model-resolution.js";
import type { OpenCodeAgentConfig } from "./sdk-types.js";
import { translateAgent } from "./translate-agent.js";

const log = logger.child({ module: "adapter-opencode/materialize-agents" });

/** What OpenCode is given, and the report the engine was given about it. */
export interface OpenCodeMaterialization {
  /** Translated agent configs, keyed by agent name, in plan order. */
  readonly translated: ReadonlyMap<string, OpenCodeAgentConfig>;
  /** Which agents OpenCode holds, and why any others were refused. */
  readonly report: HarnessMaterializationReport;
  /** The engine plan the translated configs came from. */
  readonly plan: MaterializationPlan;
}

/** Injectable steps, so tests can make a single agent fail. */
export interface OpenCodeMaterializerDependencies {
  readonly materializeAgents?: typeof engineMaterializeAgents;
  readonly resolveModel?: typeof resolveModelForAgent;
  readonly translate?: typeof translateAgent;
}

/** Composes, translates and reports the agents one OpenCode V1 plugin load registers. */
export class OpenCodeAgentMaterializer {
  private readonly materializeAgents: typeof engineMaterializeAgents;
  private readonly resolveModel: typeof resolveModelForAgent;
  private readonly translate: typeof translateAgent;

  constructor(dependencies: OpenCodeMaterializerDependencies = {}) {
    this.materializeAgents =
      dependencies.materializeAgents ?? engineMaterializeAgents;
    this.resolveModel = dependencies.resolveModel ?? resolveModelForAgent;
    this.translate = dependencies.translate ?? translateAgent;
  }

  /**
   * Compose and translate every agent. If translation refused any, compose
   * again with the adapter's report so routers offer only what OpenCode
   * holds, and translate that second plan.
   */
  async materialize(config: WeaveConfig): Promise<OpenCodeMaterialization> {
    const first = this.translatePlan(await this.compose(config));
    if (first.report.failed.length === 0) return first;

    log.info(
      { refused: first.report.failed.map((failure) => failure.agentName) },
      "Re-composing agents so no router offers an agent OpenCode does not hold",
    );
    return this.translatePlan(await this.compose(config, first.report));
  }

  private async compose(
    config: WeaveConfig,
    harness?: HarnessMaterializationReport,
  ): Promise<MaterializationPlan> {
    // materializeAgents returns ResultAsync<MaterializationPlan, never> — it
    // always resolves to ok(), so unwrapping is safe.
    const plan = (
      await this.materializeAgents({ config, harness })
    )._unsafeUnwrap();
    if (plan.errors.length > 0) {
      log.warn(
        { errors: plan.errors.map((error) => error.type) },
        "Materialization plan has partial errors — some agents may not be registered",
      );
    }
    return plan;
  }

  private translatePlan(plan: MaterializationPlan): OpenCodeMaterialization {
    const translated = new Map<string, OpenCodeAgentConfig>();
    const failed: UnavailableAgent[] = [];

    for (const { agentName, descriptor } of plan.agents) {
      // Resolve model using an empty context (no harness model context
      // available at config-hook time — the hook runs before the harness is
      // fully started).
      const modelResult = this.resolveModel(descriptor, {});
      if (modelResult.isErr()) {
        log.warn(
          {
            agent: agentName,
            errorType: modelResult.error.type,
            message: modelResult.error.message,
          },
          "Model resolution failed for agent — skipping config hook injection for this agent",
        );
        failed.push({
          agentName,
          reason: "model_unresolved",
          message: modelResult.error.message,
        });
        continue;
      }

      if (modelResult.value === undefined && descriptor.models.length > 0) {
        log.debug(
          { agent: agentName, models: descriptor.models },
          "No provider-qualified model preference — omitting model so OpenCode uses its default",
        );
      }

      const translateResult = this.translate(descriptor, modelResult.value);
      if (translateResult.isErr()) {
        log.warn(
          {
            agent: agentName,
            error: translateResult.error.type,
            message: translateResult.error.message,
          },
          "Translation failed for agent — skipping config hook injection for this agent",
        );
        failed.push({
          agentName,
          reason: "translation_failed",
          message: translateResult.error.message,
        });
        continue;
      }

      translated.set(agentName, translateResult.value);
      log.debug({ agent: agentName }, "Agent translated for config hook");
    }

    return {
      translated,
      report: { materialized: [...translated.keys()], failed },
      plan,
    };
  }
}
