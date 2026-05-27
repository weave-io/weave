/**
 * OpenCode harness adapter implementation.
 *
 * This module contains the `OpenCodeAdapter` class and its constructor options.
 * It is extracted from `index.ts` to allow `plugin.ts` to import the adapter
 * without creating a circular dependency through the barrel.
 *
 * Boundary rule: this module imports SDK types only through `./sdk-types`.
 * It must not import directly from `@opencode-ai/sdk`.
 */

import { BunFilesystemPlanStateProvider } from "@weave/config";
import type {
  AgentDescriptor,
  HarnessAdapter,
  PlanStateProvider,
  SkillInfo,
} from "@weave/engine";
import { logger } from "@weave/engine";
import {
  type OpenCodeModelContext,
  resolveModelForAgent,
} from "./model-resolution.js";
import type { OpenCodeClientFacade } from "./opencode-client.js";
import { reconcileAgent } from "./reconcile-agent.js";
import type { OpenCodeAgentConfig } from "./sdk-types.js";
import { translateAgent } from "./translate-agent.js";

const log = logger.child({ module: "adapter-opencode" });

type OpenCodeAdapterErrorType =
  | "ModelResolutionError"
  | "TranslateAgentError"
  | "ReconcileAgentError";

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

/**
 * Constructor options for `OpenCodeAdapter`.
 */
export interface OpenCodeAdapterOptions {
  /**
   * Absolute path to the project root directory.
   *
   * Used to construct the `BunFilesystemPlanStateProvider` so that plan files
   * are resolved relative to the correct project root. Defaults to
   * `Bun.env.PWD ?? "."` when omitted.
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

  /**
   * OpenCode model context for model resolution.
   *
   * When provided, `spawnSubagent()` calls `resolveModelForAgent()` with this
   * context to validate model intent before materializing each agent.
   *
   * When omitted, model resolution falls back to the engine's constant
   * fallback model (`DEFAULT_FALLBACK_MODEL`).
   */
  readonly modelContext?: OpenCodeModelContext;

  /**
   * Harness-provided skill list for `loadAvailableSkills()`.
   *
   * The OpenCode harness (SDK/runtime) is responsible for discovering which
   * skills are available. Callers inject the harness-provided skill list here
   * so the adapter can forward it to the engine without performing any
   * filesystem scanning.
   *
   * When omitted, `loadAvailableSkills()` returns an empty list. The engine
   * will then emit `MissingSkill` errors for any declared skills that cannot
   * be resolved — this is the correct hard-error behavior.
   *
   * @example
   * ```ts
   * // In an OpenCode plugin entry point, the SDK provides available skills:
   * const harnessSkills = sdk.listAvailableSkills(); // harness-owned discovery
   * const adapter = new OpenCodeAdapter({
   *   availableSkills: harnessSkills.map(s => ({ name: s.name, metadata: s })),
   * });
   * ```
   */
  readonly availableSkills?: SkillInfo[];
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

  /** Absolute path to the project root. Defaults to `Bun.env.PWD ?? "."`. */
  private readonly projectRoot: string;

  /**
   * Injected OpenCode client facade.
   *
   * Provided by the caller at construction time. `undefined` when the adapter
   * is constructed without a client (translation-only mode). No global SDK
   * state is created or mutated by the adapter.
   */
  private readonly openCodeClient: OpenCodeClientFacade | undefined;

  /**
   * OpenCode model context for model resolution.
   *
   * Provided by the caller at construction time. When `undefined`, model
   * resolution falls back to the engine's constant fallback model.
   */
  private readonly modelContext: OpenCodeModelContext;

  /**
   * Harness-provided skill list.
   *
   * Injected at construction time by the caller (e.g. an OpenCode plugin entry
   * point that received the skill list from the harness SDK). The adapter
   * forwards this list to the engine via `loadAvailableSkills()` without
   * performing any filesystem scanning.
   *
   * `undefined` when no skills were injected (adapter returns empty list).
   */
  private readonly harnessSkills: SkillInfo[] | undefined;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.projectRoot = options.projectRoot ?? Bun.env.PWD ?? ".";
    this.openCodeClient = options.client;
    this.modelContext = options.modelContext ?? {};
    this.harnessSkills = options.availableSkills;
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
   * Forwards the harness-provided skill list injected at construction time via
   * `OpenCodeAdapterOptions.availableSkills`. The OpenCode harness (SDK/runtime)
   * is responsible for discovering which skills exist; the adapter's role is to
   * receive that list and forward it to the engine for skill resolution.
   *
   * When no skills were injected, returns an empty list. The engine will then
   * emit `MissingSkill` errors for any declared skills that cannot be resolved —
   * this is the correct hard-error behavior (no silent skips).
   *
   * Boundary rule: this method must not scan the filesystem, query harness
   * directories, or perform any harness-owned discovery. All discovery is
   * delegated to the harness and injected via the constructor.
   */
  async loadAvailableSkills(): Promise<SkillInfo[]> {
    const skills = this.harnessSkills ?? [];
    log.debug(
      { count: skills.length, injected: this.harnessSkills !== undefined },
      "Returning harness-provided skill list",
    );
    return [...skills];
  }

  /**
   * Materialise a sub-agent from the provided normalized descriptor.
   *
   * ## Flow
   *
   * 1. Resolve the model for this agent using `resolveModelForAgent()` with
   *    the adapter-provided OpenCode model context. Throws on model resolution
   *    failure (e.g. unsupported explicit subagent model).
   * 2. Translate the descriptor into an OpenCode `AgentConfig` via
   *    `translateAgent`, passing the resolved model. Throws on translation
   *    failure.
   * 3. Store the translated config in `translatedAgents` for test inspection
   *    and transitional compatibility.
   * 4. When an `OpenCodeClientFacade` is available, call `reconcileAgent()` to
   *    perform the SDK-backed `list → reconcile → create/update` flow.
   *    Throws on reconciliation failure (including collision errors).
   * 5. When no client is available, log a warning and return (translation-only
   *    mode — no SDK calls are made).
   *
   * @param descriptor - Full normalized agent descriptor to materialise.
   * @throws {OpenCodeAdapterError} When model resolution fails, translation
   *   fails, or SDK-backed materialization fails.
   */
  async spawnSubagent(descriptor: AgentDescriptor): Promise<void> {
    // Step 1: Resolve model using adapter-provided OpenCode model context.
    const modelResult = resolveModelForAgent(descriptor, this.modelContext);

    if (modelResult.isErr()) {
      const error = modelResult.error;
      log.error(
        {
          agent: descriptor.name,
          errorType: error.type,
          message: error.message,
        },
        "Failed to resolve model for agent",
      );
      throw new OpenCodeAdapterError({
        type: "ModelResolutionError",
        agentName: descriptor.name,
        message: `Failed to resolve model for agent "${descriptor.name}": [${error.type}] ${error.message}`,
        cause: error,
      });
    }

    const resolvedModel = modelResult.value;

    // Step 2: Translate descriptor to OpenCode AgentConfig with resolved model.
    const translateResult = translateAgent(descriptor, resolvedModel);

    if (translateResult.isErr()) {
      log.error(
        {
          agent: descriptor.name,
          error: translateResult.error.type,
          message: translateResult.error.message,
        },
        "Failed to translate agent descriptor",
      );
      throw new OpenCodeAdapterError({
        type: "TranslateAgentError",
        agentName: descriptor.name,
        message: `Failed to translate agent descriptor for "${descriptor.name}": ${translateResult.error.message}`,
        cause: translateResult.error,
      });
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
      throw new OpenCodeAdapterError({
        type: "ReconcileAgentError",
        agentName: descriptor.name,
        message: `Failed to materialize agent "${descriptor.name}" via OpenCode SDK: [${error.type}] ${error.message}`,
        cause: error,
      });
    }

    log.info(
      { agent: descriptor.name },
      "Agent materialized successfully via OpenCode SDK",
    );
  }
}
