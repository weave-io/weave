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
import type { OpenCodeClientFacade } from "./opencode-client.js";
import { reconcileAgent } from "./reconcile-agent.js";
import type { OpenCodeAgentConfig } from "./sdk-types.js";
import { translateAgent } from "./translate-agent.js";

export type {
  OpenCodeClientError,
  OpenCodeClientFacade,
} from "./opencode-client.js";
export { SdkOpenCodeClient } from "./opencode-client.js";
export type {
  ReconcileAgentError,
  ReconcileDecision,
} from "./reconcile-agent.js";
export {
  classifyExistingAgent,
  reconcileAgent,
  tagWithOwnership,
  WEAVE_OWNERSHIP_TAG,
} from "./reconcile-agent.js";
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

  /**
   * Injected OpenCode client facade.
   *
   * Callers (e.g. an OpenCode plugin entry point) provide a pre-constructed
   * `OpenCodeClientFacade` that wraps the SDK client available in the
   * plugin/runtime context. When omitted, the adapter operates in
   * translation-only mode (no live SDK calls).
   *
   * Dependency injection through this option is the primary adapter entry
   * path. No global SDK client state is created or mutated by the adapter.
   *
   * @example
   * ```ts
   * import { createOpencodeClient } from "@opencode-ai/sdk";
   * import { OpenCodeAdapter, SdkOpenCodeClient } from "@weave/adapter-opencode";
   *
   * const sdkClient = createOpencodeClient({ directory: projectDir });
   * const adapter = new OpenCodeAdapter({
   *   projectRoot: projectDir,
   *   client: new SdkOpenCodeClient(sdkClient),
   * });
   * ```
   */
  readonly client?: OpenCodeClientFacade;
}

/**
 * OpenCode harness adapter.
 *
 * Implements the `HarnessAdapter` interface to materialise Weave agent
 * descriptors into a running OpenCode instance via the OpenCode SDK client.
 *
 * When an `OpenCodeClientFacade` is injected, `spawnSubagent()` performs
 * real SDK-backed materialization using the `list → reconcile → create/update`
 * flow in `reconcile-agent.ts`. Without a client the adapter falls back to
 * translation-only mode (no SDK calls are made).
 *
 * `translatedAgents` is retained as a read-only snapshot of the last
 * translated config for each agent. It is populated regardless of whether SDK
 * materialization succeeds, and is available for test inspection and
 * transitional compatibility. It is NOT the primary materialization path.
 *
 * A `BunFilesystemPlanStateProvider` is constructed during `init()` and stored
 * as `this.planStateProvider`. Pass it to any `completeStep` call that uses a
 * `plan_created` or `plan_complete` completion method.
 */
export class OpenCodeAdapter implements HarnessAdapter {
  /**
   * Read-only snapshot of the last translated OpenCode agent config for each
   * agent, keyed by agent name.
   *
   * Populated by `spawnSubagent()` after successful translation, regardless of
   * whether SDK materialization is attempted. Useful for test inspection and
   * transitional compatibility.
   *
   * The primary materialization path is the SDK-backed `reconcileAgent()` call
   * inside `spawnSubagent()`. This map is a secondary artifact, not the source
   * of truth for what is actually registered in OpenCode.
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

  /**
   * Injected OpenCode client facade.
   *
   * Provided by the caller at construction time. `undefined` when the adapter
   * is constructed without a client (translation-only mode). No global SDK
   * state is created or mutated by the adapter.
   */
  private readonly openCodeClient: OpenCodeClientFacade | undefined;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.openCodeClient = options.client;
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
    log.info(
      {
        projectRoot: this.projectRoot,
        hasClient: this.openCodeClient !== undefined,
      },
      "OpenCodeAdapter initialized",
    );
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
   * ## Flow
   *
   * 1. Translate the descriptor into an OpenCode `AgentConfig` via
   *    `translateAgent`. Throws on translation failure.
   * 2. Store the translated config in `translatedAgents` for test inspection
   *    and transitional compatibility.
   * 3. When an `OpenCodeClientFacade` is available, call `reconcileAgent()` to
   *    perform the SDK-backed `list → reconcile → create/update` flow.
   *    Throws on reconciliation failure (including collision errors).
   * 4. When no client is available, log a warning and return (translation-only
   *    mode — no SDK calls are made).
   *
   * @param descriptor - Full normalized agent descriptor to materialise.
   * @throws {Error} When translation fails or SDK-backed materialization fails.
   */
  async spawnSubagent(descriptor: AgentDescriptor): Promise<void> {
    const translateResult = translateAgent(descriptor);

    if (translateResult.isErr()) {
      log.error(
        {
          agent: descriptor.name,
          error: translateResult.error.type,
          message: translateResult.error.message,
        },
        "Failed to translate agent descriptor",
      );
      throw new Error(
        `Failed to translate agent descriptor for "${descriptor.name}": ${translateResult.error.message}`,
      );
    }

    const config = translateResult.value;

    // Store translated config for test inspection and transitional compatibility.
    // This is a secondary artifact — the SDK-backed path below is primary.
    this.translatedAgents.set(descriptor.name, config);

    log.info(
      {
        agent: descriptor.name,
        model: config.model,
        mode: config.mode,
      },
      "Agent descriptor translated successfully",
    );

    if (this.openCodeClient === undefined) {
      log.warn(
        { agent: descriptor.name },
        "No OpenCode client injected — skipping SDK materialization (translation-only mode)",
      );
      return;
    }

    // SDK-backed materialization: list existing → reconcile → create/update
    const reconcileResult = await reconcileAgent(
      descriptor.name,
      config,
      this.openCodeClient,
    );

    if (reconcileResult.isErr()) {
      const error = reconcileResult.error;
      log.error(
        {
          agent: descriptor.name,
          errorType: error.type,
          message: error.message,
        },
        "Failed to materialize agent via SDK",
      );
      throw new Error(
        `Failed to materialize agent "${descriptor.name}" via OpenCode SDK: [${error.type}] ${error.message}`,
      );
    }

    log.info(
      { agent: descriptor.name },
      "Agent materialized successfully via OpenCode SDK",
    );
  }
}
