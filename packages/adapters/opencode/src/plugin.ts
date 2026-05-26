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
 * 4. It constructs an `OpenCodeAdapter` with the injected `SdkOpenCodeClient`
 *    and calls `spawnSubagent()` for each descriptor.
 * 5. It returns an empty `Hooks` object — agent materialization is the sole
 *    responsibility of this plugin; no additional hooks are registered.
 *
 * ## Installation
 *
 * Add `@weave/adapter-opencode` to the `plugin` array in `opencode.json`:
 *
 * ```jsonc
 * // opencode.json
 * {
 *   "plugin": ["@weave/adapter-opencode"]
 * }
 * ```
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
import { loadConfig } from "@weave/config";
import { logger, materializeAgents } from "@weave/engine";

import { OpenCodeAdapter } from "./adapter.js";
import { SdkOpenCodeClient } from "./opencode-client.js";

const log = logger.child({ module: "adapter-opencode/plugin" });

/**
 * Weave OpenCode plugin.
 *
 * Loaded by OpenCode at startup when `@weave/adapter-opencode` is listed in
 * the `plugin` array of `opencode.json`. Materializes all agents declared in
 * `.weave/config.weave` into the running OpenCode instance.
 *
 * @param input - Runtime context provided by OpenCode, including the SDK
 *   client and the project directory.
 * @returns An empty `Hooks` object — agent materialization is the sole
 *   responsibility of this plugin.
 */
export const WeavePlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  const { client: sdkClient, directory } = input;

  log.info({ directory }, "Weave plugin starting");

  // Load Weave config from the project directory.
  const configResult = await loadConfig(directory);
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

  // Construct the adapter with the harness-injected SDK client.
  const adapter = new OpenCodeAdapter({
    projectRoot: directory,
    client: new SdkOpenCodeClient(sdkClient),
  });

  await adapter.init();

  // Materialize each agent descriptor into the running OpenCode instance.
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
      log.info({ agent: agentName }, "Agent materialized");
    }
  }

  log.info(
    { agentCount: plan.agents.length },
    "Weave plugin initialization complete",
  );

  // Return empty hooks — agent materialization is the sole responsibility.
  return {};
};

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
