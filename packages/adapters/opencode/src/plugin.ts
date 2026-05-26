/**
 * OpenCode plugin entry point for `@weave/adapter-opencode`.
 *
 * This module exports the `Plugin` function that OpenCode loads at startup
 * when `@weave/adapter-opencode` is listed in the `plugin` array of
 * `opencode.json`. It is the primary runtime integration surface between
 * Weave and OpenCode.
 *
 * ## How it works
 *
 * 1. OpenCode calls the exported `server` function (the `Plugin`) with a
 *    `PluginInput` context that includes a pre-constructed SDK client and the
 *    project directory.
 * 2. The plugin loads the Weave config from `input.directory` via
 *    `loadConfig()`.
 * 3. It calls `materializeAgents()` to compose all agent descriptors from the
 *    resolved config.
 * 4. It translates each descriptor into an `OpenCodeAgentConfig` via
 *    `translateAgent()` and collects the results into a `translatedMap`.
 * 5. It returns a `Hooks` object with two responsibilities:
 *    a. **`config` hook** — injects the translated agent configs into
 *       `cfg.agent` so that `opencode debug config` reflects all Weave-managed
 *       agents. This runs once at startup before OpenCode finalises its config.
 *    b. **SDK-backed reconciliation** — after the `config` hook is registered,
 *       the plugin also calls `spawnSubagent()` for each descriptor via
 *       `OpenCodeAdapter`. This performs the `list → reconcile → create/update`
 *       flow that persists agents into the running OpenCode instance's runtime
 *       store (not just the in-memory config snapshot).
 *
 * ## Why both paths?
 *
 * The `config` hook and the SDK-backed reconciliation serve different purposes:
 *
 * - The `config` hook makes agents visible to `opencode debug config` and to
 *   any OpenCode subsystem that reads the merged config at startup. It is
 *   purely additive — it does not persist agents across restarts.
 * - The SDK-backed reconciliation (`spawnSubagent`) writes agents into
 *   OpenCode's runtime store via `client.config.update()`. This is the
 *   durable path that survives config reloads and is the source of truth for
 *   what OpenCode actually uses at runtime.
 *
 * Both paths are required for full materialization: the `config` hook for
 * observability and startup-time config visibility, and the SDK path for
 * runtime persistence and ownership-safe upsert.
 *
 * ## Installation
 *
 * Add `@weave/adapter-opencode/plugin` to the `plugin` array in `opencode.json`.
 * Use the subpath export — **not** the bare package name:
 *
 * ```jsonc
 * // opencode.json
 * {
 *   "plugin": ["@weave/adapter-opencode/plugin"]
 * }
 * ```
 *
 * The bare `@weave/adapter-opencode` entry (`dist/index.js`) exports non-function
 * values (constants, type re-exports) that cause OpenCode's `getLegacyPlugins`
 * loader to throw `TypeError: Plugin export is not a function`. This module
 * (`dist/plugin.js`) exports only the plugin function and is the correct entry
 * point for OpenCode.
 *
 * Restart OpenCode after adding the plugin. The plugin entry point receives
 * the runtime context, constructs an `OpenCodeAdapter` with the injected SDK
 * client, and materializes all agents declared in `.weave/config.weave`.
 *
 * ## Boundary rules
 *
 * - The plugin entry point is the only place that imports from
 *   `@opencode-ai/plugin`. All other adapter modules remain plugin-agnostic.
 * - The `PluginInput.client` is injected into `SdkOpenCodeClient` — the
 *   adapter never constructs its own SDK client.
 * - Config loading and agent materialization follow the same path as any
 *   other adapter consumer: `loadConfig → materializeAgents → spawnSubagent`.
 */

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { type FileReader, loadConfig } from "@weave/config";
import { logger, materializeAgents } from "@weave/engine";

import { OpenCodeAdapter } from "./adapter.js";
import { resolveModelForAgent } from "./model-resolution.js";
import {
  type OpenCodeClientFacade,
  SdkOpenCodeClient,
} from "./opencode-client.js";
import type { OpenCodeAgentConfig } from "./sdk-types.js";
import { translateAgent } from "./translate-agent.js";

const log = logger.child({ module: "adapter-opencode/plugin" });

/**
 * Options for `createWeavePlugin`.
 *
 * All fields are optional. In production, the defaults are used. In tests,
 * pass a custom `fileReader` and/or `clientFacade` to isolate the test from
 * the developer's environment.
 */
export interface WeavePluginOptions {
  /**
   * Custom file reader for config loading.
   *
   * In production, the default `bunFileReader` is used. In tests, pass a
   * `projectOnlyReader` to prevent the developer's global config from
   * interfering with test results.
   *
   * @example
   * ```ts
   * const plugin = createWeavePlugin({ fileReader: projectOnlyReader(root) });
   * const hooks = await plugin(input);
   * ```
   */
  readonly fileReader?: FileReader;

  /**
   * Pre-constructed `OpenCodeClientFacade` to use instead of wrapping
   * `input.client` in `SdkOpenCodeClient`.
   *
   * In production, this is always `undefined` — the plugin wraps `input.client`
   * (the raw SDK client) in `SdkOpenCodeClient`. In tests, pass a
   * `MockOpenCodeClient` here to avoid needing a real SDK client.
   *
   * @example
   * ```ts
   * const mockClient = new MockOpenCodeClient();
   * const plugin = createWeavePlugin({ clientFacade: mockClient });
   * const hooks = await plugin(input);
   * ```
   */
  readonly clientFacade?: OpenCodeClientFacade;
}

/**
 * Creates a Weave OpenCode plugin with optional configuration.
 *
 * Returns a `Plugin` function that OpenCode can load at startup. In
 * production, call `createWeavePlugin()` with no arguments (or use the
 * pre-built `WeavePlugin` export). In tests, pass a custom `fileReader` to
 * isolate the test from the developer's global `~/.weave/config.weave`.
 *
 * @param options - Optional plugin configuration.
 * @returns A `Plugin` function compatible with `@opencode-ai/plugin`.
 */
export function createWeavePlugin(options: WeavePluginOptions = {}): Plugin {
  return async (input: PluginInput): Promise<Hooks> => {
    const { client: sdkClient, directory } = input;

    log.info({ directory }, "Weave plugin starting");

    // Load Weave config from the project directory.
    const configResult = await loadConfig(directory, options.fileReader);
    if (configResult.isErr()) {
      const errors = configResult.error;
      log.error(
        { errors },
        "Failed to load Weave config — no agents will be materialized",
      );
      // Return empty hooks rather than throwing — a config load failure should
      // not crash the entire OpenCode session. The error is logged for diagnosis.
      return {};
    }

    const config = configResult.value;

    // Compose all agent descriptors from the resolved config.
    const planResult = await materializeAgents({ config });

    // materializeAgents returns ResultAsync<MaterializationPlan, never> — it
    // always resolves to ok(). The never error type means we can safely unwrap.
    const plan = planResult._unsafeUnwrap();

    if (plan.errors.length > 0) {
      log.warn(
        { errors: plan.errors.map((e: { type: string }) => e.type) },
        "Materialization plan has partial errors — some agents may not be registered",
      );
    }

    // Translate each descriptor into an OpenCodeAgentConfig and collect into a
    // map. This map is used by the config hook to inject agents into cfg.agent.
    // Translation is performed here (before the config hook is returned) so that
    // any translation errors are surfaced at startup, not deferred to hook time.
    const translatedMap = new Map<string, OpenCodeAgentConfig>();

    for (const { agentName, descriptor } of plan.agents) {
      // Resolve model using an empty context (no harness model context available
      // at config-hook time — the hook runs before the harness is fully started).
      const modelResult = resolveModelForAgent(descriptor, {});

      if (modelResult.isErr()) {
        log.warn(
          {
            agent: agentName,
            errorType: modelResult.error.type,
            message: modelResult.error.message,
          },
          "Model resolution failed for agent — skipping config hook injection for this agent",
        );
        continue;
      }

      const translateResult = translateAgent(descriptor, modelResult.value);

      if (translateResult.isErr()) {
        log.warn(
          {
            agent: agentName,
            error: translateResult.error.type,
            message: translateResult.error.message,
          },
          "Translation failed for agent — skipping config hook injection for this agent",
        );
        continue;
      }

      translatedMap.set(agentName, translateResult.value);
      log.debug({ agent: agentName }, "Agent translated for config hook");
    }

    log.info(
      { agentCount: translatedMap.size },
      "Agents translated for config hook injection",
    );

    // Construct the adapter with the harness-injected SDK client.
    // In production, wrap the raw SDK client in SdkOpenCodeClient.
    // In tests, use the pre-constructed clientFacade directly (bypasses
    // SdkOpenCodeClient wrapping so mock clients work without a live SDK).
    const clientFacade: OpenCodeClientFacade =
      options.clientFacade ?? new SdkOpenCodeClient(sdkClient);

    const adapter = new OpenCodeAdapter({
      projectRoot: directory,
      client: clientFacade,
    });

    await adapter.init();

    // Perform SDK-backed reconciliation for each agent descriptor.
    // This persists agents into OpenCode's runtime store via config.update().
    // The config hook (returned below) is the startup-time visibility path;
    // SDK reconciliation is the durable persistence path.
    for (const { agentName, descriptor } of plan.agents) {
      const spawnResult = await adapter.spawnSubagent(descriptor).then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, error: err }),
      );

      if (!spawnResult.ok) {
        log.error(
          { agent: agentName, error: spawnResult.error },
          "Failed to materialize agent — continuing with remaining agents",
        );
      } else {
        log.info({ agent: agentName }, "Agent materialized via SDK");
      }
    }

    log.info(
      { agentCount: plan.agents.length },
      "Weave plugin initialization complete",
    );

    // Return hooks with a config hook that injects translated agents into
    // cfg.agent. This makes agents visible to `opencode debug config` and to
    // any OpenCode subsystem that reads the merged config at startup.
    return {
      config: async (cfg) => {
        if (translatedMap.size === 0) return;

        // Ensure cfg.agent exists before patching.
        if (cfg.agent === undefined) {
          cfg.agent = {};
        }

        for (const [agentName, agentConfig] of translatedMap) {
          cfg.agent[agentName] = agentConfig;
          log.debug({ agent: agentName }, "Agent injected into config hook");
        }

        log.info(
          { agentCount: translatedMap.size },
          "Weave agents injected into OpenCode config",
        );
      },
    };
  };
}

/**
 * Weave OpenCode plugin.
 *
 * Loaded by OpenCode at startup when `@weave/adapter-opencode` is listed in
 * the `plugin` array of `opencode.json`. Materializes all agents declared in
 * `.weave/config.weave` into the running OpenCode instance.
 *
 * Returns a `Hooks` object with:
 * - `config` hook — injects translated agent configs into `cfg.agent` so that
 *   `opencode debug config` shows all Weave-managed agents.
 *
 * Additionally performs SDK-backed reconciliation (`spawnSubagent`) for each
 * agent to persist them into OpenCode's runtime store.
 *
 * @param input - Runtime context provided by OpenCode, including the SDK
 *   client and the project directory.
 * @returns A `Hooks` object with a `config` hook on success, or an empty
 *   `Hooks` object when config loading fails.
 */
export const WeavePlugin: Plugin = createWeavePlugin();

/**
 * Named `server` export for `PluginModule` compatibility.
 *
 * OpenCode resolves plugins as `PluginModule` objects with a `server` property.
 * When the module's default export is a function, OpenCode also accepts it
 * directly as the plugin. Both forms are exported here for maximum
 * compatibility.
 */
export const server = WeavePlugin;

export default WeavePlugin;
