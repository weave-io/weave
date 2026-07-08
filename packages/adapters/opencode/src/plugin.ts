/**
 * OpenCode plugin entry point for `@weaveio/weave-adapter-opencode`.
 *
 * This module exports the `Plugin` function that OpenCode loads at startup
 * when `@weaveio/weave-adapter-opencode` is listed in the `plugin` array of
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
 * 5. It returns a `Hooks` object **immediately** with two hooks:
 *    a. **`config` hook** — injects the translated agent configs into
 *       `cfg.agent` so that `opencode debug config` reflects all Weave-managed
 *       agents. This runs once at startup before OpenCode finalises its config.
 *    b. **`event` hook** — listens for the first `session.created` event and
 *       then performs SDK-backed reconciliation (`adapter.init()` +
 *       `spawnSubagent()`) exactly once per plugin activation. This defers the
 *       SDK/DB path to real session time, so `opencode debug config` is never
 *       blocked by runtime SDK calls.
 *
 * ## Why deferred SDK reconciliation?
 *
 * `opencode debug config` calls the plugin function and waits for `Hooks` to
 * be returned. In the previous design, `adapter.init()` and `spawnSubagent()`
 * were called eagerly before `Hooks` was returned. Both operations touch the
 * OpenCode SDK / DB path (`client.app.agents()`, `config.update()`), which
 * hangs in the `debug config` context because the runtime store is not
 * available.
 *
 * The fix: config loading and agent translation are pure computation (no SDK
 * calls). `Hooks` is returned immediately after translation. SDK reconciliation
 * is deferred to the `event` hook, which only fires during a real OpenCode
 * session — never during `debug config`.
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
 * Add `@weaveio/weave-adapter-opencode` to the `plugin` array in `opencode.json`:
 *
 * ```jsonc
 * // opencode.json
 * {
 *   "plugin": ["@weaveio/weave-adapter-opencode"]
 * }
 * ```
 *
 * OpenCode resolves the `./server` subpath export from `package.json`, which
 * points to this module (`dist/plugin.js`). The bare package name works because
 * the `./server` export is defined alongside the main entry point.
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

import { join } from "node:path";
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { type FileReader, loadConfig } from "@weaveio/weave-config";
import {
  type AgentDescriptor,
  env,
  logger,
  materializeAgents,
  redirectLogsToFile,
} from "@weaveio/weave-engine";

import { OpenCodeAdapter } from "./adapter.js";
import {
  START_WORK_COMMAND_TEMPLATE,
  WEAVE_START_COMMAND_TEMPLATE,
} from "./command-templates.js";
import { resolveModelForAgent } from "./model-resolution.js";
import {
  type OpenCodeClientFacade,
  SdkOpenCodeClient,
} from "./opencode-client.js";
import { tagWithOwnership } from "./reconcile-agent.js";
import type { OpenCodeAgentConfig } from "./sdk-types.js";
import { translateAgent } from "./translate-agent.js";

const log = logger.child({ module: "adapter-opencode/plugin" });

/**
 * Default log file path relative to the project directory.
 *
 * When the OpenCode plugin runs without an explicit `WEAVE_LOG_FILE` env var,
 * Weave logs are written to this path under the project root. The `.weave/`
 * directory is already the conventional home for Weave project state, so
 * placing the log file there keeps everything in one place.
 *
 * Example: `/path/to/project/.weave/weave.log`
 *
 * Not exported from `plugin.ts` — the plugin entry point must export only
 * functions to satisfy OpenCode's `getLegacyPlugins` loader. This constant
 * is exported from the barrel `index.ts` as a standalone export.
 */
const DEFAULT_PLUGIN_LOG_SUBPATH = ".weave/weave.log";

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
 * The returned plugin function:
 * 1. Loads Weave config and translates agent descriptors (pure computation).
 * 2. Returns `Hooks` **immediately** — never blocks on SDK/DB calls.
 * 3. Defers `adapter.init()` + `spawnSubagent()` to the `event` hook, which
 *    fires on the first `session.created` event during a real OpenCode session.
 *
 * This design ensures `opencode debug config` returns quickly because it only
 * exercises the `config` hook path, never the deferred SDK reconciliation path.
 *
 * @param options - Optional plugin configuration.
 * @returns A `Plugin` function compatible with `@opencode-ai/plugin`.
 */
export function createWeavePlugin(options: WeavePluginOptions = {}): Plugin {
  return async (input: PluginInput): Promise<Hooks> => {
    const { client: sdkClient, directory } = input;

    // Redirect logs to a project-local file before any log calls.
    //
    // When running as an OpenCode plugin, stdout is read by the OpenCode UI.
    // Writing structured JSON logs to stdout would surface raw log lines in
    // the chat interface, which is confusing for users.
    //
    // `redirectLogsToFile` is a no-op when `WEAVE_LOG_FILE` is already set
    // (the env var is the explicit override). Otherwise it redirects the
    // shared pino stream to `.weave/weave.log` under the project directory.
    // All existing child loggers share the same stream and automatically write
    // to the new destination after this call.
    //
    // We only redirect when the project directory exists. If it doesn't (e.g.
    // in tests using a non-existent path), we skip the redirect and let logs
    // fall through to stdout — the config load will fail anyway.
    if (!env.WEAVE_LOG_FILE) {
      // Check if the project directory exists before redirecting. If it
      // doesn't (e.g. in tests using a non-existent path), skip the redirect
      // and let logs fall through to stdout — the config load will fail anyway.
      // Note: Bun.file().exists() returns false for directories; use stat().
      const dirExists = await Bun.file(directory)
        .stat()
        .then(() => true)
        .catch(() => false);
      if (dirExists) {
        await redirectLogsToFile(join(directory, DEFAULT_PLUGIN_LOG_SUBPATH));
      }
    }

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

    // Capture the agent descriptors for deferred SDK reconciliation.
    // These are used by the event hook when a real session starts.
    const agentDescriptors: Array<{
      agentName: string;
      descriptor: AgentDescriptor;
    }> = plan.agents.map(({ agentName, descriptor }) => ({
      agentName,
      descriptor,
    }));

    // Build the client facade once. In production, wrap the raw SDK client in
    // SdkOpenCodeClient. In tests, use the pre-constructed clientFacade directly
    // (bypasses SdkOpenCodeClient wrapping so mock clients work without a live SDK).
    const clientFacade: OpenCodeClientFacade =
      options.clientFacade ?? new SdkOpenCodeClient(sdkClient);

    // Deferred SDK reconciliation state.
    // `reconciled` is set to true after the first successful reconciliation so
    // that the event hook does not repeat the work on subsequent events.
    let reconciled = false;

    /**
     * Perform SDK-backed reconciliation exactly once.
     *
     * Called from the `event` hook on the first `session.created` event.
     * Constructs the adapter, initialises it, and calls `spawnSubagent()` for
     * each agent descriptor. Errors are logged but do not throw — a failed
     * reconciliation for one agent does not block the others.
     *
     * If `adapter.init()` throws, the error is caught, logged, and the
     * function returns early so the event hook does not reject.
     */
    async function runReconciliation(): Promise<void> {
      if (reconciled) return;
      reconciled = true;

      log.info(
        { agentCount: agentDescriptors.length },
        "Running deferred SDK reconciliation (session.created)",
      );

      const adapter = new OpenCodeAdapter({
        projectRoot: directory,
        client: clientFacade,
      });

      try {
        await adapter.init();
      } catch (initErr: unknown) {
        log.error(
          { error: initErr },
          "adapter.init() failed — aborting deferred SDK reconciliation",
        );
        return;
      }

      for (const { agentName, descriptor } of agentDescriptors) {
        const spawnResult = await adapter.spawnSubagent(descriptor);

        if (spawnResult.isErr()) {
          log.error(
            { agent: agentName, error: spawnResult.error },
            "Failed to materialize agent — continuing with remaining agents",
          );
        } else {
          log.info({ agent: agentName }, "Agent materialized via SDK");
        }
      }

      log.info(
        { agentCount: agentDescriptors.length },
        "Deferred SDK reconciliation complete",
      );
    }

    log.info("Weave plugin hooks ready — returning immediately");

    // Return hooks immediately. The config hook is populated now; the event
    // hook defers SDK reconciliation to the first real session.
    return {
      config: async (cfg) => {
        // --- Agent injection ---
        if (translatedMap.size > 0) {
          if (cfg.agent === undefined) {
            cfg.agent = {};
          }

          for (const [agentName, agentConfig] of translatedMap) {
            // Tag with ownership before injecting so that deferred SDK
            // reconciliation (session.created) sees the same ownership marker
            // and classifies these agents as "update" rather than "collision".
            cfg.agent[agentName] = tagWithOwnership(agentConfig);
            log.debug({ agent: agentName }, "Agent injected into config hook");
          }

          log.info(
            { agentCount: translatedMap.size },
            "Weave agents injected into OpenCode config",
          );
        }

        // --- Default agent configuration ---
        // Set Loom as the default agent so new sessions start with the
        // orchestrator rather than OpenCode's built-in 'build' agent.
        // Type assertion needed: OpenCode supports `default_agent` but the
        // @opencode-ai/plugin type definitions may lag behind the runtime.
        if (translatedMap.has("loom")) {
          (cfg as Record<string, unknown>).default_agent = "loom";
          log.info("Set default_agent to 'loom'");
        }

        // --- Command injection ---
        // Register /start-work and /weave:start as OpenCode slash commands.
        // These are prompt-based commands (not LLM tools) — they inject the
        // Tapestry execution template into the conversation when the user
        // types the command in the TUI.
        if (cfg.command === undefined) {
          cfg.command = {};
        }

        cfg.command["start-work"] = {
          template: START_WORK_COMMAND_TEMPLATE,
          description: "Start executing a Weave plan created by Pattern",
          agent: "tapestry",
        };

        cfg.command["weave:start"] = {
          template: WEAVE_START_COMMAND_TEMPLATE,
          description: "Start executing a Weave plan (preferred command)",
          agent: "tapestry",
        };

        log.info(
          { commands: ["start-work", "weave:start"] },
          "Weave slash commands registered",
        );
      },

      event: async ({ event }) => {
        if (event.type !== "session.created") return;
      },
    };
  };
}

/**
 * Weave OpenCode plugin.
 *
 * Loaded by OpenCode at startup when `@weaveio/weave-adapter-opencode` is listed in
 * the `plugin` array of `opencode.json`. Materializes all agents declared in
 * `.weave/config.weave` into the running OpenCode instance.
 *
 * Returns a `Hooks` object **immediately** with:
 * - `config` hook — injects translated agent configs into `cfg.agent` so that
 *   `opencode debug config` shows all Weave-managed agents.
 * - `event` hook — defers SDK-backed reconciliation (`spawnSubagent`) to the
 *   first `session.created` event, ensuring `opencode debug config` never
 *   blocks on SDK/DB calls.
 *
 * @param input - Runtime context provided by OpenCode, including the SDK
 *   client and the project directory.
 * @returns A `Hooks` object with `config` and `event` hooks on success, or an
 *   empty `Hooks` object when config loading fails.
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
