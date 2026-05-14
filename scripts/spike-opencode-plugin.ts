import { resolve } from "node:path";
import {
  OpenCodeAdapter,
  type OpenCodePluginHooks,
} from "@weave/adapter-opencode";
import { resolvePromptPaths } from "@weave/config";
import {
  type AgentConfig,
  type ConfigError,
  formatError,
  parseConfig,
  type WeaveConfig,
} from "@weave/core";
import { logger, WeaveRunner } from "@weave/engine";
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";

const log = logger.child({ module: "spike-opencode-plugin" });

// SPIKE: Materialize the prompt-composition spike under conflict-free names so
// OpenCode can load it alongside the real built-in Weave agents.
const SOURCE_SPIKE_AGENT_NAMES = ["loom", "thread"] as const;
const SOURCE_TO_SPIKE_AGENT_NAME = {
  loom: "loom-v2",
  thread: "thread-v2",
} as const;

type SourceSpikeAgentName = (typeof SOURCE_SPIKE_AGENT_NAMES)[number];
type SpikeHarnessEntryError =
  | {
      type: "ConfigNotFoundError";
      path: string;
      message: string;
    }
  | {
      type: "ConfigReadError";
      path: string;
      cause: unknown;
      message: string;
    }
  | {
      type: "ConfigParseError";
      path: string;
      errors: ConfigError[];
      message: string;
    }
  | {
      type: "MissingSpikeAgentError";
      agentName: SourceSpikeAgentName;
      message: string;
    }
  | {
      type: "RunnerExecutionError";
      cause: unknown;
      message: string;
    };

function readConfigSource(
  configPath: string,
): ResultAsync<string, SpikeHarnessEntryError> {
  const file = Bun.file(configPath);

  return ResultAsync.fromPromise(file.exists(), (cause: unknown) => ({
    type: "ConfigReadError" as const,
    path: configPath,
    cause,
    message: `Failed to check whether config exists at ${configPath}.`,
  })).andThen((exists: boolean) => {
    if (!exists) {
      return errAsync<never, SpikeHarnessEntryError>({
        type: "ConfigNotFoundError",
        path: configPath,
        message: `Config not found at ${configPath}.`,
      });
    }

    return ResultAsync.fromPromise(file.text(), (cause: unknown) => ({
      type: "ConfigReadError" as const,
      path: configPath,
      cause,
      message: `Failed to read config at ${configPath}.`,
    }));
  });
}

function parseProjectConfig(
  source: string,
  configPath: string,
  projectRoot: string,
): Result<WeaveConfig, SpikeHarnessEntryError> {
  const parsed = parseConfig(source);
  if (parsed.isErr()) {
    return err({
      type: "ConfigParseError",
      path: configPath,
      errors: parsed.error,
      message: `Failed to parse ${configPath}.`,
    });
  }

  return ok(
    resolvePromptPaths(parsed.value, {
      kind: "project",
      rootDir: resolve(projectRoot, ".weave"),
    }),
  );
}

function renameSpikeAgentConfig(
  agentName: SourceSpikeAgentName,
  agentConfig: AgentConfig,
): AgentConfig {
  // SPIKE: Preserve the declared config while remapping only the harness-facing
  // logical agent name.
  return {
    ...agentConfig,
    name: SOURCE_TO_SPIKE_AGENT_NAME[agentName],
  };
}

function renameDisabledSpikeAgents(disabledAgents: string[]): string[] {
  const renamedDisabledAgents: string[] = [];

  for (const agentName of disabledAgents) {
    if (agentName === "loom") {
      renamedDisabledAgents.push(SOURCE_TO_SPIKE_AGENT_NAME.loom);
      continue;
    }

    if (agentName === "thread") {
      renamedDisabledAgents.push(SOURCE_TO_SPIKE_AGENT_NAME.thread);
    }
  }

  return renamedDisabledAgents;
}

function filterSpikeConfig(
  config: WeaveConfig,
): Result<WeaveConfig, SpikeHarnessEntryError> {
  const agents: WeaveConfig["agents"] = {};

  for (const agentName of SOURCE_SPIKE_AGENT_NAMES) {
    const agent = config.agents[agentName];
    if (agent === undefined) {
      return err({
        type: "MissingSpikeAgentError",
        agentName,
        message: `Spike config requires the \"${agentName}\" agent to be defined.`,
      });
    }

    const renamedAgentName = SOURCE_TO_SPIKE_AGENT_NAME[agentName];
    agents[renamedAgentName] = renameSpikeAgentConfig(agentName, agent);
  }

  return ok({
    ...config,
    agents,
    categories: {},
    workflows: {},
    disabled: {
      ...config.disabled,
      agents: renameDisabledSpikeAgents(config.disabled.agents),
    },
  });
}

function loadSpikeConfig(
  projectRoot: string,
): ResultAsync<WeaveConfig, SpikeHarnessEntryError> {
  const configPath = resolve(projectRoot, ".weave", "config.weave");

  return readConfigSource(configPath).andThen((source: string) => {
    const parsedConfig = parseProjectConfig(source, configPath, projectRoot);
    if (parsedConfig.isErr()) return errAsync(parsedConfig.error);

    const filteredConfig = filterSpikeConfig(parsedConfig.value);
    if (filteredConfig.isErr()) return errAsync(filteredConfig.error);

    return okAsync(filteredConfig.value);
  });
}

function createSpikePlugin(
  projectRoot: string,
): ResultAsync<OpenCodePluginHooks, SpikeHarnessEntryError> {
  return loadSpikeConfig(projectRoot).andThen((config: WeaveConfig) => {
    const adapter = new OpenCodeAdapter();
    const runner = new WeaveRunner(config, adapter);

    return ResultAsync.fromPromise(runner.run(), (cause: unknown) => ({
      type: "RunnerExecutionError" as const,
      cause,
      message: "Failed to materialize the OpenCode spike plugin.",
    })).map(() => adapter.toPlugin());
  });
}

function logSpikeHarnessEntryError(error: SpikeHarnessEntryError): void {
  log.error({ error }, error.message);

  if (error.type !== "ConfigParseError") return;

  for (const configError of error.errors) {
    log.error({ path: error.path }, formatError(configError));
  }
}

export default async function loadSpikeOpenCodePlugin(): Promise<OpenCodePluginHooks> {
  // SPIKE: Resolve from the project root so the file can be passed directly via
  // `opencode.json` during live harness validation.
  const projectRoot = process.cwd();

  return createSpikePlugin(projectRoot).match(
    (hooks: OpenCodePluginHooks) => hooks,
    (error: SpikeHarnessEntryError) => {
      logSpikeHarnessEntryError(error);
      return {};
    },
  );
}
