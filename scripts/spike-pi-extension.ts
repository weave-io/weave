import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PiAdapter, type PiExtensionAPI } from "@weave/adapter-pi";
import { resolvePromptPaths } from "@weave/config";
import {
  type ConfigError,
  formatError,
  parseConfig,
  type WeaveConfig,
} from "@weave/core";
import { logger, WeaveRunner } from "@weave/engine";
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";

const log = logger.child({ module: "spike-pi-extension" });

// SPIKE: Materialize only the prompt-composition spike agents used for Pi
// validation.
const SOURCE_SPIKE_AGENT_NAMES = ["loom", "thread"] as const;

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
    }
  | {
      type: "ExtensionExecutionError";
      cause: unknown;
      message: string;
    };

function readConfigSource(
  configPath: string,
): ResultAsync<string, SpikeHarnessEntryError> {
  return ResultAsync.fromPromise(
    (async () => {
      try {
        return await readFile(configPath, "utf-8");
      } catch (cause: unknown) {
        if (hasErrorCode(cause, "ENOENT")) {
          throw createConfigNotFoundError(configPath);
        }

        throw createConfigReadError(configPath, cause);
      }
    })(),
    (cause: unknown) => toSpikeHarnessEntryError(configPath, cause),
  );
}

function createConfigNotFoundError(configPath: string): SpikeHarnessEntryError {
  return {
    type: "ConfigNotFoundError",
    path: configPath,
    message: `Config not found at ${configPath}.`,
  };
}

function createConfigReadError(
  configPath: string,
  cause: unknown,
): SpikeHarnessEntryError {
  return {
    type: "ConfigReadError",
    path: configPath,
    cause,
    message: `Failed to read config at ${configPath}.`,
  };
}

function toSpikeHarnessEntryError(
  configPath: string,
  cause: unknown,
): SpikeHarnessEntryError {
  if (isSpikeHarnessEntryError(cause)) return cause;

  return createConfigReadError(configPath, cause);
}

function hasErrorCode(
  error: unknown,
  expectedCode: string,
): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === expectedCode;
}

function isSpikeHarnessEntryError(
  error: unknown,
): error is SpikeHarnessEntryError {
  return typeof error === "object" && error !== null && "type" in error;
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

    agents[agentName] = agent;
  }

  return ok({
    ...config,
    agents,
    categories: {},
    workflows: {},
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

function runSpikePiExtension(
  projectRoot: string,
  pi: PiExtensionAPI,
): ResultAsync<void, SpikeHarnessEntryError> {
  return loadSpikeConfig(projectRoot).andThen((config: WeaveConfig) => {
    const adapter = new PiAdapter();
    const runner = new WeaveRunner(config, adapter);

    return ResultAsync.fromPromise(runner.run(), (cause: unknown) => ({
      type: "RunnerExecutionError" as const,
      cause,
      message: "Failed to materialize the Pi spike extension.",
    })).andThen(() => {
      const extensionFactory = adapter.toExtension();

      return ResultAsync.fromThrowable(
        (piApi: PiExtensionAPI) => Promise.resolve(extensionFactory(piApi)),
        (cause: unknown) => ({
          type: "ExtensionExecutionError" as const,
          cause,
          message: "Failed to execute the Pi spike extension factory.",
        }),
      )(pi);
    });
  });
}

function logSpikeHarnessEntryError(error: SpikeHarnessEntryError): void {
  log.error({ error }, error.message);

  if (error.type !== "ConfigParseError") return;

  for (const configError of error.errors) {
    log.error({ path: error.path }, formatError(configError));
  }
}

export default async function loadSpikePiExtension(
  pi: PiExtensionAPI,
): Promise<void> {
  // SPIKE: Resolve from the project root so the file can be passed directly via
  // Pi's `--extension` flag during live harness validation.
  const projectRoot = process.cwd();

  await runSpikePiExtension(projectRoot, pi).match(
    () => undefined,
    (error: SpikeHarnessEntryError) => {
      logSpikeHarnessEntryError(error);
    },
  );
}
