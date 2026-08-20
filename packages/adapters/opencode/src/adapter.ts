/**
 * OpenCode harness adapter implementation.
 *
 * The adapter translates normalized Weave descriptors into OpenCode config
 * entries for the runtime command projections. Live plugin materialization is
 * owned by the plugin's config hook; this class does not call an OpenCode SDK
 * or persist agent configuration.
 *
 * SDK types flow through `sdk-types.ts`. Harness-specific translation remains
 * inside this adapter package and never crosses into the engine.
 */

import { BunFilesystemPlanStateProvider } from "@weaveio/weave-config";
import type {
  AgentDescriptor,
  HarnessAdapter,
  PlanStateProvider,
  SkillInfo,
} from "@weaveio/weave-engine";
import { logger } from "@weaveio/weave-engine";
import { errAsync, ResultAsync } from "neverthrow";
import {
  type OpenCodeModelContext,
  resolveModelForAgent,
} from "./model-resolution.js";
import type { OpenCodeAgentConfig } from "./sdk-types.js";
import {
  describeFastActivation,
  type OpenCodeFastActivationReport,
  translateAgent,
} from "./translate-agent.js";

const log = logger.child({ module: "adapter-opencode" });

type OpenCodeAdapterErrorType = "ModelResolutionError" | "TranslateAgentError";

export class OpenCodeAdapterError extends Error {
  readonly type: OpenCodeAdapterErrorType;
  readonly agentName: string;
  readonly cause: unknown;

  constructor(input: {
    type: OpenCodeAdapterErrorType;
    agentName: string;
    message: string;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "OpenCodeAdapterError";
    this.type = input.type;
    this.agentName = input.agentName;
    this.cause = input.cause;
  }
}

/** Constructor options for `OpenCodeAdapter`. */
export interface OpenCodeAdapterOptions {
  /**
   * Absolute path to the project root directory.
   *
   * Used to construct the plan-state provider. Defaults to
   * `Bun.env.PWD ?? "."` when omitted.
   */
  readonly projectRoot?: string;

  /**
   * OpenCode model context used when runtime projections translate a
   * descriptor. Config-hook startup uses its own harness-independent fallback
   * context because OpenCode has not exposed model context at that point.
   */
  readonly modelContext?: OpenCodeModelContext;

  /**
   * Harness-provided skills. OpenCode owns discovery; the adapter only
   * forwards the injected list to the engine.
   */
  readonly availableSkills?: SkillInfo[];
}

/**
 * OpenCode harness adapter.
 *
 * `spawnSubagent()` translates a descriptor and records the result for the
 * explicit runtime command projections. It does not register or update a
 * live OpenCode agent. The plugin config hook is the single live
 * materialization path and refuses same-name collisions.
 */
export class OpenCodeAdapter implements HarnessAdapter {
  /** Last translated config for each agent, keyed by canonical name. */
  readonly translatedAgents: Map<string, OpenCodeAgentConfig> = new Map();

  /** Bounded reports for descriptors that request unsupported acceleration. */
  readonly fastActivationReports: Map<string, OpenCodeFastActivationReport> =
    new Map();

  /** Plan-state provider, populated by `init()`. */
  planStateProvider: PlanStateProvider | undefined = undefined;

  private readonly projectRoot: string;
  private readonly modelContext: OpenCodeModelContext;
  private readonly harnessSkills: SkillInfo[] | undefined;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.projectRoot = options.projectRoot ?? Bun.env.PWD ?? ".";
    this.modelContext = options.modelContext ?? {};
    this.harnessSkills = options.availableSkills;
  }

  /** Construct the plan-state provider used by runtime command projections. */
  async init(): Promise<void> {
    this.planStateProvider = new BunFilesystemPlanStateProvider(
      this.projectRoot,
    );
    log.info({ projectRoot: this.projectRoot }, "OpenCodeAdapter initialized");
  }

  /** Return the harness-provided skills without performing discovery. */
  async loadAvailableSkills(): Promise<SkillInfo[]> {
    const skills = this.harnessSkills ?? [];
    log.debug(
      { count: skills.length, injected: this.harnessSkills !== undefined },
      "Returning harness-provided skill list",
    );
    return [...skills];
  }

  /**
   * Translate one normalized descriptor for an explicit runtime projection.
   *
   * The returned result is successful after translation. Live config
   * injection is intentionally not performed here; the plugin config hook
   * owns that boundary and applies collision protection before assignment.
   */
  spawnSubagent(
    descriptor: AgentDescriptor,
  ): ResultAsync<void, OpenCodeAdapterError> {
    const modelResult = resolveModelForAgent(descriptor, this.modelContext);
    if (modelResult.isErr()) {
      log.error(
        {
          agent: descriptor.name,
          errorType: modelResult.error.type,
          message: modelResult.error.message,
        },
        "Failed to resolve model for agent",
      );
      return errAsync(
        new OpenCodeAdapterError({
          type: "ModelResolutionError",
          agentName: descriptor.name,
          message: `Failed to resolve model for agent "${descriptor.name}": [${modelResult.error.type}] ${modelResult.error.message}`,
          cause: modelResult.error,
        }),
      );
    }

    const translateResult = translateAgent(descriptor, modelResult.value.model);
    if (translateResult.isErr()) {
      log.error(
        {
          agent: descriptor.name,
          error: translateResult.error.type,
          message: translateResult.error.message,
        },
        "Failed to translate agent descriptor",
      );
      return errAsync(
        new OpenCodeAdapterError({
          type: "TranslateAgentError",
          agentName: descriptor.name,
          message: `Failed to translate agent descriptor for "${descriptor.name}": ${translateResult.error.message}`,
          cause: translateResult.error,
        }),
      );
    }

    const config = translateResult.value;
    this.translatedAgents.set(descriptor.name, config);

    const fastReport = describeFastActivation(descriptor);
    if (fastReport === undefined) {
      this.fastActivationReports.delete(descriptor.name);
    } else {
      this.fastActivationReports.set(descriptor.name, fastReport);
      log.warn(
        {
          agent: descriptor.name,
          capability: fastReport.capability,
          state: fastReport.state,
          reason: fastReport.reason,
        },
        "Provider acceleration intent is unsupported in OpenCode; translation continues without an acceleration control",
      );
    }

    log.info(
      {
        agent: descriptor.name,
        model: config.model,
        mode: config.mode,
      },
      "Agent descriptor translated successfully",
    );

    return ResultAsync.fromSafePromise(Promise.resolve());
  }
}
