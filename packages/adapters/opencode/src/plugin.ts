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
 * Default log file path relative to the project directory.
 *
 * This constant is intentionally local to the plugin entry point. The barrel
 * exports the same path for callers that need to document or test the plugin
 * logging behavior.
 */
const DEFAULT_PLUGIN_LOG_SUBPATH = ".weave/weave.log";

/**
 * Bound host-owned config maps before inspecting or mutating them.
 *
 * OpenCode supplies these maps. A large map, an accessor, a symbol, a custom
 * prototype, or an operation that throws is not a usable mutation seam. The
 * check is deliberately conservative and uses descriptors only, so checking
 * an existing map never reads a getter. JavaScript cannot identify every
 * transparent Proxy; the post-mutation descriptor proof below therefore
 * remains mandatory, and an unproven mutation never grants ownership.
 */
const MAX_CONFIG_MAP_ENTRIES = 256;

type ConfigMapProperty = "agent" | "command";
type OpenCodeCommandConfig = NonNullable<
  NonNullable<OpenCodePluginConfig["command"]>[string]
>;
type ConfigMapEntry =
  | OpenCodeAgentConfig
  | OpenCodeCommandConfig
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;
type ExternalConfigMap = { [key: string]: ConfigMapEntry };
type ConfigMapCandidate = ExternalConfigMap | ConfigMapEntry;
type DescriptorHost = OpenCodePluginConfig | ExternalConfigMap;
type EnumerableDataDescriptor = PropertyDescriptor & {
  value: ConfigMapEntry;
};

interface SafeConfigMapState {
  readonly map: ExternalConfigMap;
  readonly prototype: object | null;
  readonly descriptors: ReadonlyMap<string, EnumerableDataDescriptor>;
}

function isEnumerableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is EnumerableDataDescriptor {
  return (
    descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.enumerable === true
  );
}

function sameDataDescriptor(
  left: EnumerableDataDescriptor,
  right: EnumerableDataDescriptor,
): boolean {
  return (
    left.value === right.value &&
    left.writable === right.writable &&
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable
  );
}

/** Reject primitive and callable candidates without reading map properties. */
function isConfigMapCandidate(
  value: ConfigMapCandidate,
): value is ExternalConfigMap {
  try {
    return (
      value !== null && Object(value) === value && !(value instanceof Function)
    );
  } catch {
    return false;
  }
}

function isStringPropertyKey(key: PropertyKey): key is string {
  return key === String(key);
}

/** Snapshot a host map without reading any property value. */
function inspectSafeConfigMap(
  value: ConfigMapCandidate,
): SafeConfigMapState | undefined {
  if (!isConfigMapCandidate(value)) return undefined;

  try {
    const map = value;
    const prototype = Object.getPrototypeOf(map);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (!Object.isExtensible(map)) return undefined;

    const keys = Reflect.ownKeys(map);
    if (keys.length > MAX_CONFIG_MAP_ENTRIES) return undefined;

    const descriptors = new Map<string, EnumerableDataDescriptor>();
    for (const key of keys) {
      if (!isStringPropertyKey(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(map, key);
      if (!isEnumerableDataDescriptor(descriptor)) return undefined;
      descriptors.set(key, descriptor);
    }

    // A Proxy or a mutating host must not be able to change the map between
    // the bounded key walk and the descriptor snapshot.
    if (Object.getPrototypeOf(map) !== prototype) return undefined;
    if (!Object.isExtensible(map)) return undefined;
    const finalKeys = Reflect.ownKeys(map);
    if (
      finalKeys.length !== keys.length ||
      finalKeys.some((key, index) => key !== keys[index])
    ) {
      return undefined;
    }

    return { map, prototype, descriptors };
  } catch {
    return undefined;
  }
}

function sameMapEntries(
  left: SafeConfigMapState,
  right: SafeConfigMapState,
): boolean {
  if (left.map !== right.map || left.prototype !== right.prototype) {
    return false;
  }
  if (left.descriptors.size !== right.descriptors.size) return false;

  for (const [key, descriptor] of left.descriptors) {
    const other = right.descriptors.get(key);
    if (other === undefined || !sameDataDescriptor(descriptor, other)) {
      return false;
    }
  }

  return true;
}

function hasExactMapEntry(
  state: SafeConfigMapState,
  name: string,
  expected: ConfigMapEntry,
): boolean {
  const descriptor = state.descriptors.get(name);
  return (
    descriptor !== undefined &&
    descriptor.enumerable === true &&
    descriptor.value === expected
  );
}

/** Verify that only one exact own entry appeared after a mutation. */
function provesInsertedMapEntry(
  before: SafeConfigMapState,
  after: SafeConfigMapState,
  name: string,
  expected: ConfigMapEntry,
): boolean {
  if (before.descriptors.has(name)) return false;
  if (after.descriptors.size !== before.descriptors.size + 1) return false;

  for (const [key, descriptor] of before.descriptors) {
    const other = after.descriptors.get(key);
    if (other === undefined || !sameDataDescriptor(descriptor, other)) {
      return false;
    }
  }

  return hasExactMapEntry(after, name, expected);
}

function hasExactOwnDataProperty(
  target: DescriptorHost,
  property: string,
  expected: ConfigMapEntry,
): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    return (
      descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.value === expected
    );
  } catch {
    return false;
  }
}

/**
 * Read or create one config map without invoking a host getter or setter.
 *
 * A newly-created map has a null prototype and is owned by this adapter. An
 * existing map must pass the bounded descriptor check before it is used.
 */
function establishSafeConfigMap(
  cfg: OpenCodePluginConfig,
  property: ConfigMapProperty,
): SafeConfigMapState | undefined {
  let propertyDescriptor: PropertyDescriptor | undefined;
  try {
    propertyDescriptor = Object.getOwnPropertyDescriptor(cfg, property);
  } catch {
    return undefined;
  }

  // Accessor-valued config fields are not inspected or invoked.
  if (propertyDescriptor !== undefined && !("value" in propertyDescriptor)) {
    return undefined;
  }

  const existingMap = propertyDescriptor?.value;
  if (existingMap !== undefined) {
    return inspectSafeConfigMap(existingMap);
  }

  const map: ExternalConfigMap = Object.create(null);
  const replacement =
    propertyDescriptor === undefined
      ? {
          value: map,
          writable: true,
          enumerable: true,
          configurable: true,
        }
      : { value: map };

  try {
    if (!Reflect.defineProperty(cfg, property, replacement)) return undefined;
    if (!hasExactOwnDataProperty(cfg, property, map)) return undefined;
  } catch {
    return undefined;
  }

  return inspectSafeConfigMap(map);
}

/**
 * Insert through the ordinary map mutation seam, then prove what happened.
 * `Reflect.set` intentionally exercises a hostile Proxy's set/define traps;
 * the descriptor proof below refuses an absorbed or mismatched assignment.
 */
function insertAndVerifyMapEntry(
  cfg: OpenCodePluginConfig,
  property: ConfigMapProperty,
  state: SafeConfigMapState,
  name: string,
  value: ConfigMapEntry,
): SafeConfigMapState | undefined {
  if (state.descriptors.has(name)) return undefined;

  let mutationSucceeded = false;
  try {
    const prototypeDescriptor =
      state.prototype === null
        ? undefined
        : Object.getOwnPropertyDescriptor(state.prototype, name);

    // Object.prototype.__proto__ is an inherited setter. Defining this one
    // unusual key avoids executing it while retaining set-trap coverage for
    // all ordinary OpenCode names.
    if (
      name === "__proto__" ||
      (prototypeDescriptor !== undefined && !("value" in prototypeDescriptor))
    ) {
      mutationSucceeded = Reflect.defineProperty(state.map, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      mutationSucceeded = Reflect.set(state.map, name, value, state.map);
    }
  } catch {
    return undefined;
  }

  if (!mutationSucceeded) return undefined;

  const after = inspectSafeConfigMap(state.map);
  if (
    after === undefined ||
    !provesInsertedMapEntry(state, after, name, value) ||
    !hasExactOwnDataProperty(cfg, property, state.map)
  ) {
    return undefined;
  }

  return after;
}

/** Keep only an unchanged, still-safe map state after all mutations. */
function stabilizeSafeConfigMap(
  cfg: OpenCodePluginConfig,
  property: ConfigMapProperty,
  state: SafeConfigMapState,
): SafeConfigMapState | undefined {
  const current = inspectSafeConfigMap(state.map);
  if (
    current === undefined ||
    !sameMapEntries(state, current) ||
    !hasExactOwnDataProperty(cfg, property, state.map)
  ) {
    return undefined;
  }
  return current;
}

function setDefaultAgent(cfg: OpenCodePluginConfig, value: string): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cfg, "default_agent");
    if (descriptor !== undefined && !("value" in descriptor)) return false;
    const defined = Reflect.defineProperty(
      cfg,
      "default_agent",
      descriptor === undefined
        ? {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          }
        : { value },
    );
    return defined && hasExactOwnDataProperty(cfg, "default_agent", value);
  } catch {
    return false;
  }
}

/** Options for `createWeavePlugin`. */
export interface WeavePluginOptions {
  /** Custom file reader used to isolate config loading in tests. */
  readonly fileReader?: FileReader;
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
      config: async (cfg) => {
        let agentState: SafeConfigMapState | undefined;
        const insertedAgents = new Map<string, OpenCodeAgentConfig>();

        if (translatedMap.size > 0) {
          agentState = establishSafeConfigMap(cfg, "agent");
          if (agentState === undefined) {
            log.warn(
              "Skipping Weave agent injection because cfg.agent is not a safe host map",
            );
          } else {
            for (const [agentName, agentConfig] of translatedMap) {
              // A same-name entry is a collision, even when its editable
              // metadata resembles a Weave entry. Never replace or merge it.
              if (agentState.descriptors.has(agentName)) {
                log.warn(
                  { agent: agentName },
                  "Skipping existing OpenCode agent in config hook",
                );
                continue;
              }

              const nextState = insertAndVerifyMapEntry(
                cfg,
                "agent",
                agentState,
                agentName,
                agentConfig,
              );
              if (nextState === undefined) {
                log.warn(
                  { agent: agentName },
                  "Agent insertion was not proven in the config hook",
                );
                continue;
              }

              agentState = nextState;
              insertedAgents.set(agentName, agentConfig);
              log.debug(
                { agent: agentName },
                "Agent injected into config hook",
              );
            }

            const stableAgentState = stabilizeSafeConfigMap(
              cfg,
              "agent",
              agentState,
            );
            if (stableAgentState === undefined) {
              log.warn(
                "Skipping agent authorization because cfg.agent changed during config-hook materialization",
              );
              agentState = undefined;
              insertedAgents.clear();
            } else {
              agentState = stableAgentState;
            }
          }

          log.info(
            {
              agentCount: insertedAgents.size,
              skippedCount: translatedMap.size - insertedAgents.size,
            },
            "Weave agents projected into OpenCode config",
          );
        }

        // Only choose Loom when this invocation proved that it inserted Loom
        // and the final map still contains that exact object.
        const loomInjected =
          agentState !== undefined &&
          insertedAgents.has("loom") &&
          hasExactMapEntry(agentState, "loom", insertedAgents.get("loom"));
        if (loomInjected) {
          if (setDefaultAgent(cfg, "loom")) {
            log.info("Set default_agent to 'loom'");
          } else {
            log.warn(
              "Loom was inserted, but default_agent could not be safely set",
            );
          }
        }

        // Commands are owned by this hook only when this invocation inserted
        // Tapestry and the exact inserted object remains proven. A collision
        // or failed/skipped Tapestry must never become a command target.
        const tapestryInjected =
          agentState !== undefined &&
          insertedAgents.has("tapestry") &&
          hasExactMapEntry(
            agentState,
            "tapestry",
            insertedAgents.get("tapestry"),
          );
        if (!tapestryInjected) {
          log.warn(
            "Skipping Weave slash command registration because Tapestry was not injected by this config hook",
          );
          return;
        }

        let commandState = establishSafeConfigMap(cfg, "command");
        if (commandState === undefined) {
          log.warn(
            "Skipping Weave slash command registration because cfg.command is not a safe host map",
          );
          return;
        }

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
        const insertedCommands = new Map<
          string,
          (typeof commandDefinitions)["start-work"]
        >();

        for (const [commandName, command] of Object.entries(
          commandDefinitions,
        )) {
          // Preserve every existing command object, including nested fields.
          if (commandState.descriptors.has(commandName)) {
            log.warn(
              { command: commandName },
              "Skipping existing OpenCode command in config hook",
            );
            continue;
          }

          const nextState = insertAndVerifyMapEntry(
            cfg,
            "command",
            commandState,
            commandName,
            command,
          );
          if (nextState === undefined) {
            log.warn(
              { command: commandName },
              "Command insertion was not proven in the config hook",
            );
            continue;
          }

          commandState = nextState;
          insertedCommands.set(commandName, command);
        }

        const stableCommandState = stabilizeSafeConfigMap(
          cfg,
          "command",
          commandState,
        );
        const registeredCommands: string[] = [];
        if (stableCommandState === undefined) {
          log.warn(
            "Skipping command authorization because cfg.command changed during config-hook materialization",
          );
        } else {
          for (const [commandName, command] of insertedCommands) {
            if (hasExactMapEntry(stableCommandState, commandName, command)) {
              registeredCommands.push(commandName);
            }
          }
        }

        log.info(
          { commands: registeredCommands },
          "Weave slash commands registered",
        );
      },
    };
  };
}

/** OpenCode's Weave plugin entry point. */
export const WeavePlugin: Plugin = createWeavePlugin();

/** Named `server` export for OpenCode `PluginModule` compatibility. */
export const server = WeavePlugin;

export default WeavePlugin;
