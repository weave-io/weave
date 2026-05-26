/**
 * @weave/adapter-opencode
 *
 * OpenCode harness adapter for the Weave orchestration framework.
 *
 * This adapter translates normalized Weave `AgentDescriptor` intent into
 * concrete OpenCode agent configuration via the `@opencode-ai/sdk` client.
 *
 * Boundary rule: this package is the only consumer of `@opencode-ai/sdk`.
 * All SDK type imports flow through `./sdk-types` — never directly from the
 * SDK package.
 */

import { BunFilesystemPlanStateProvider } from "@weave/config";
import type {
  AgentDescriptor,
  HarnessAdapter,
  PlanStateProvider,
  SkillInfo,
} from "@weave/engine";
import { logger } from "@weave/engine";

import type { OpenCodeAgentConfig } from "./sdk-types.js";
import { translateAgent } from "./translate-agent.js";

export type {
  RunWorkflowError,
  RunWorkflowInput,
  RunWorkflowResult,
} from "./run-workflow.js";
export { runWorkflow } from "./run-workflow.js";

const log = logger.child({ module: "adapter-opencode" });

/**
 * Constructor options for `OpenCodeAdapter`.
 */
export interface OpenCodeAdapterOptions {
  /**
   * Absolute path to the project root directory.
   *
   * Used to construct the `BunFilesystemPlanStateProvider` so that plan files
   * are resolved relative to the correct project root. Defaults to
   * `process.cwd()` when omitted.
   */
  readonly projectRoot?: string;
}

/**
 * OpenCode harness adapter.
 *
 * Implements the `HarnessAdapter` interface to materialise Weave agent
 * descriptors into a running OpenCode instance via the OpenCode SDK client.
 *
 * Translated agent configs are stored in an in-memory map keyed by agent name.
 * Actual file writing / SDK registration is handled in a subsequent task.
 *
 * A `BunFilesystemPlanStateProvider` is constructed during `init()` and stored
 * as `this.planStateProvider`. Pass it to any `completeStep` call that uses a
 * `plan_created` or `plan_complete` completion method.
 */
export class OpenCodeAdapter implements HarnessAdapter {
  /**
   * In-memory store of translated OpenCode agent configs, keyed by agent name.
   * Populated by `spawnSubagent`; consumed by the config-write task (task 10).
   */
  readonly translatedAgents: Map<string, OpenCodeAgentConfig> = new Map();

  /**
   * Provider for querying plan file state.
   *
   * Constructed during `init()` using `projectRoot`. Pass to `completeStep`
   * calls that use `plan_created` or `plan_complete` completion methods.
   *
   * `undefined` before `init()` is called.
   */
  planStateProvider: PlanStateProvider | undefined = undefined;

  /** Absolute path to the project root. Defaults to `process.cwd()`. */
  private readonly projectRoot: string;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
  }

  /**
   * Perform one-time initialisation required before any agent can be
   * materialised. Called exactly once by the bootstrap entry point.
   *
   * Constructs a `BunFilesystemPlanStateProvider` rooted at `this.projectRoot`
   * and stores it as `this.planStateProvider` for use in lifecycle calls.
   */
  async init(): Promise<void> {
    this.planStateProvider = new BunFilesystemPlanStateProvider(
      this.projectRoot,
    );
    log.info({ projectRoot: this.projectRoot }, "OpenCodeAdapter initialized");
  }

  /**
   * Return the list of skills available in the current OpenCode instance.
   *
   * The engine calls this once during bootstrap — after `init()` and before
   * agent materialisation — to obtain the adapter-provided skill context used
   * for skill resolution.
   *
   * @returns Empty array in this skeleton; concrete discovery is implemented
   *   in a subsequent task.
   */
  async loadAvailableSkills(): Promise<SkillInfo[]> {
    log.debug("loadAvailableSkills called (stub — returning empty list)");
    return [];
  }

  /**
   * Materialise a sub-agent from the provided normalized descriptor.
   *
   * Translates the descriptor into an OpenCode `AgentConfig` via
   * `translateAgent`, logs the outcome, and stores the result in
   * `translatedAgents` for downstream consumption (config writing, task 10).
   *
   * Throws when translation fails so the caller can handle the error rather
   * than silently continuing with a partially-materialised agent set.
   *
   * @param descriptor - Full normalized agent descriptor to materialise.
   * @throws {Error} When the descriptor cannot be translated to an OpenCode config.
   */
  async spawnSubagent(descriptor: AgentDescriptor): Promise<void> {
    const result = translateAgent(descriptor);

    if (result.isErr()) {
      log.error(
        {
          agent: descriptor.name,
          error: result.error.type,
          message: result.error.message,
        },
        "Failed to translate agent descriptor",
      );
      throw new Error(
        `Failed to translate agent descriptor for "${descriptor.name}": ${result.error.message}`,
      );
    }

    const config = result.value;
    this.translatedAgents.set(descriptor.name, config);

    log.info(
      {
        agent: descriptor.name,
        model: config.model,
        mode: config.mode,
      },
      "Agent descriptor translated successfully",
    );
  }
}
