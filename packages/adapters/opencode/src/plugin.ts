/**
 * OpenCode plugin entry point for `@weaveio/weave-adapter-opencode`.
 *
 * OpenCode calls the exported `server` function at startup. The plugin loads
 * Weave configuration, translates the normalized agents, and exposes them
 * through OpenCode's config hook. The hook is the only materialization path:
 * it changes the in-memory config that OpenCode is already assembling and
 * never calls the OpenCode SDK or a persistence API.
 *
 * Existing same-name entries are left untouched. OpenCode configuration can
 * contain user-authored agents, and this plugin has no trusted ownership
 * authority that permits replacing one. The same rule applies when an entry
 * contains metadata that looks like it came from Weave.
 *
 * The plugin registers only the prompt-based Weave slash commands. The
 * adapter's RuntimeCommandProjection is a library-only projection and is not
 * wired into this config hook; no session event starts work.
 *
 * The plugin entry point is the only module that imports `@opencode-ai/plugin`.
 * Other adapter modules remain plugin-agnostic and use `sdk-types.ts` for
 * OpenCode configuration types.
 */

import { join } from "node:path";
import type {
  Hooks,
  Config as OpenCodePluginConfig,
  Plugin,
  PluginInput,
} from "@opencode-ai/plugin";
import { type FileReader, loadConfig } from "@weaveio/weave-config";
import {
  env,
  logger,
  materializeAgents,
  redirectLogsToFile,
} from "@weaveio/weave-engine";

import {
  START_WORK_COMMAND_TEMPLATE,
  WEAVE_START_COMMAND_TEMPLATE,
} from "./command-templates.js";
import { resolveModelForAgent } from "./model-resolution.js";
import type { OpenCodeAgentConfig } from "./sdk-types.js";
import { translateAgent } from "./translate-agent.js";

const log = logger.child({ module: "adapter-opencode/plugin" });

/**
 * OpenCode calls the `config` hook after parsing user JSON/JSONC into ordinary
 * configuration records. This is an explicit trusted harness boundary. The
 * adapter preserves that contract and does not attempt to detect arbitrary
 * JavaScript proxies or prove ownership with reflection. Callers that provide
 * values outside OpenCode's config-hook contract are unsupported.
 */
type TrustedOpenCodeConfig = OpenCodePluginConfig & {
  /** OpenCode consumes this runtime field even though the SDK type omits it. */
  default_agent?: string;
};

/**
 * Default log file path relative to the project directory.
 *
 * This constant is intentionally local to the plugin entry point. The barrel
 * exports the same path for callers that need to document or test the plugin
 * logging behavior.
 */
const DEFAULT_PLUGIN_LOG_SUBPATH = ".weave/weave.log";

/** Options for `createWeavePlugin`. */
export interface WeavePluginOptions {
  /** Custom file reader used to isolate config loading in tests. */
  readonly fileReader?: FileReader;
}

/**
 * Inject translated entries into the config supplied by OpenCode.
 *
 * This function deliberately relies on the trusted OpenCode config-hook
 * contract. OpenCode supplies ordinary records, so own-name checks and normal
 * assignments are the complete materialization seam. A collision is skipped;
 * no entry is replaced, merged, rolled back, or authorized by metadata.
 */
async function applyTrustedConfig(
  cfg: TrustedOpenCodeConfig,
  translatedMap: ReadonlyMap<string, OpenCodeAgentConfig>,
): Promise<void> {
  let loomInjected = false;
  let tapestryInjected = false;
  let injectedCount = 0;

  if (translatedMap.size > 0) {
    const agents = cfg.agent ?? {};
    cfg.agent = agents;

    for (const [agentName, agentConfig] of translatedMap) {
      // OpenCode's parsed record is the source of truth for collisions. Keep
      // every existing own entry, including its nested values and identity.
      if (Object.hasOwn(agents, agentName)) {
        log.warn(
          { agent: agentName },
          "Skipping existing OpenCode agent in config hook",
        );
        continue;
      }

      agents[agentName] = agentConfig;
      injectedCount += 1;

      // These flags describe this invocation's own insertion branches. They
      // are not inferred from host metadata or a post-mutation proof.
      if (agentName === "loom") loomInjected = true;
      if (agentName === "tapestry") tapestryInjected = true;
      log.debug({ agent: agentName }, "Agent injected into config hook");
    }

    log.info(
      {
        agentCount: injectedCount,
        skippedCount: translatedMap.size - injectedCount,
      },
      "Weave agents projected into OpenCode config",
    );
  }

  // Only choose Loom when this invocation inserted it. A pre-existing Loom
  // entry remains fully user-owned and does not change the default.
  if (loomInjected) {
    cfg.default_agent = "loom";
    log.info("Set default_agent to 'loom'");
  }

  // Commands are tied to this invocation's own Tapestry insertion. A normal
  // collision or a missing Tapestry skips command registration entirely.
  if (!tapestryInjected) {
    log.warn(
      "Skipping Weave slash command registration because Tapestry was not injected by this config hook",
    );
    return;
  }

  const commands = cfg.command ?? {};
  cfg.command = commands;
  const commandDefinitions = {
    "start-work": {
      template: START_WORK_COMMAND_TEMPLATE,
      description: "Start executing a Weave plan created by Pattern",
      agent: "tapestry",
    },
    "weave:start": {
      template: WEAVE_START_COMMAND_TEMPLATE,
      description: "Start executing a Weave plan (preferred command)",
      agent: "tapestry",
    },
  };
  const registeredCommands: string[] = [];

  for (const [commandName, command] of Object.entries(commandDefinitions)) {
    // Preserve every existing command object, including nested fields.
    if (Object.hasOwn(commands, commandName)) {
      log.warn(
        { command: commandName },
        "Skipping existing OpenCode command in config hook",
      );
      continue;
    }

    commands[commandName] = command;
    registeredCommands.push(commandName);
  }

  log.info({ commands: registeredCommands }, "Weave slash commands registered");
}

/**
 * Creates the OpenCode plugin.
 *
 * The returned plugin performs config loading and translation before returning
 * its hooks. Its config hook injects translated agents and commands. It never
 * uses the SDK client supplied by OpenCode, so `opencode debug config` and a
 * live startup follow the same config-only materialization path.
 */
export function createWeavePlugin(options: WeavePluginOptions = {}): Plugin {
  return async (input: PluginInput): Promise<Hooks> => {
    const { directory } = input;

    // OpenCode reads stdout as UI output. Keep structured Weave logs in the
    // project-local file unless the caller supplied an explicit destination.
    if (!env.WEAVE_LOG_FILE) {
      const dirExists = await Bun.file(directory)
        .stat()
        .then(() => true)
        .catch(() => false);
      if (dirExists) {
        await redirectLogsToFile(join(directory, DEFAULT_PLUGIN_LOG_SUBPATH));
      }
    }

    log.info({ directory }, "Weave plugin starting");

    const configResult = await loadConfig(directory, options.fileReader);
    if (configResult.isErr()) {
      log.error(
        { errors: configResult.error },
        "Failed to load Weave config — no agents will be materialized",
      );
      return {};
    }

    const planResult = await materializeAgents({ config: configResult.value });
    // materializeAgents returns ResultAsync<MaterializationPlan, never>.
    const plan = planResult._unsafeUnwrap();

    if (plan.errors.length > 0) {
      log.warn(
        { errors: plan.errors.map((error: { type: string }) => error.type) },
        "Materialization plan has partial errors — some agents may not be registered",
      );
    }

    const translatedMap = new Map<string, OpenCodeAgentConfig>();

    for (const { agentName, descriptor } of plan.agents) {
      // Config hooks run before OpenCode exposes harness model context. The
      // adapter therefore resolves only against the descriptor and fallback.
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

      const translateResult = translateAgent(
        descriptor,
        modelResult.value.model,
      );
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

    return {
      // OpenCode's hook argument is the trusted parsed-config boundary
      // described by TrustedOpenCodeConfig above.
      config: (cfg: TrustedOpenCodeConfig) =>
        applyTrustedConfig(cfg, translatedMap),
    };
  };
}

/** OpenCode's Weave plugin entry point. */
export const WeavePlugin: Plugin = createWeavePlugin();

/** Named `server` export for OpenCode `PluginModule` compatibility. */
export const server = WeavePlugin;

export default WeavePlugin;
