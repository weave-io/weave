import { resolve } from "node:path";
import { OpenCodeAdapter } from "@weave/adapter-opencode";
import { PiAdapter, type PiExtensionAPI } from "@weave/adapter-pi";
import { resolvePromptPaths } from "@weave/config";
import {
  type AgentConfig,
  type ConfigError,
  formatError,
  parseConfig,
  type WeaveConfig,
} from "@weave/core";
import {
  composeAgentDescriptor,
  type AgentDescriptor,
  type HarnessAdapter,
  WeaveRunner,
} from "@weave/engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";

// SPIKE: Materialize the test agents under conflict-free names so they can be
// loaded alongside the real built-in loom/thread agents during live harness
// validation.
const SPIKE_AGENT_NAMES = ["loom-v2", "thread-v2"] as const;
const SOURCE_SPIKE_AGENT_NAMES = ["loom", "thread"] as const;
const SOURCE_TO_SPIKE_AGENT_NAME = {
  loom: "loom-v2",
  thread: "thread-v2",
} as const satisfies Record<(typeof SOURCE_SPIKE_AGENT_NAMES)[number], (typeof SPIKE_AGENT_NAMES)[number]>;

type SpikeAgentName = (typeof SPIKE_AGENT_NAMES)[number];
type SourceSpikeAgentName = (typeof SOURCE_SPIKE_AGENT_NAMES)[number];
type HarnessName = "opencode" | "pi";

type OpenCodeRegistrationSummary = {
  kind: "opencode";
  pluginConfig: Record<string, unknown>;
};

type PiRegistrationSummary = {
  kind: "pi";
  registeredAgents: string[];
  registeredTools: string[];
  registeredEvents: string[];
};

type SpikeComposeSummary = {
  harness: HarnessName;
  descriptors: AgentDescriptor[];
  registration: OpenCodeRegistrationSummary | PiRegistrationSummary;
};

type SpikeComposeError =
  | {
      type: "HarnessArgumentMissingError";
      message: string;
    }
  | {
      type: "HarnessArgumentInvalidError";
      value?: string;
      message: string;
    }
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
      harness: HarnessName;
      cause: unknown;
      message: string;
    }
  | {
      type: "DescriptorComposeError";
      agentName: string;
      cause: unknown;
      message: string;
    }
  | {
      type: "OpenCodeConfigHookMissingError";
      message: string;
    }
  | {
      type: "OpenCodeConfigHookExecutionError";
      cause: unknown;
      message: string;
    }
  | {
      type: "PiExtensionExecutionError";
      cause: unknown;
      message: string;
    };

function toDisplayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function writeStdout(message: string): void {
  process.stdout.write(message);
}

function writeStderr(message: string): void {
  process.stderr.write(message);
}

function parseHarnessArg(
  argv: string[],
): Result<HarnessName, SpikeComposeError> {
  const harnessIndex = argv.indexOf("--harness");

  if (harnessIndex === -1) {
    return err({
      type: "HarnessArgumentMissingError",
      message: "Missing required argument: --harness <opencode|pi>.",
    });
  }

  const harness = argv[harnessIndex + 1];
  if (harness === "opencode" || harness === "pi") return ok(harness);

  return err({
    type: "HarnessArgumentInvalidError",
    value: harness,
    message: `Invalid harness "${harness ?? ""}". Expected "opencode" or "pi".`,
  });
}

function readConfigSource(
  configPath: string,
): ResultAsync<string, SpikeComposeError> {
  const file = Bun.file(configPath);

  return ResultAsync.fromPromise(file.exists(), (cause: unknown) => ({
    type: "ConfigReadError" as const,
    path: configPath,
    cause,
    message: `Failed to check whether config exists at ${toDisplayPath(configPath)}.`,
  })).andThen((exists: boolean) => {
    if (!exists) {
      return errAsync<never, SpikeComposeError>({
        type: "ConfigNotFoundError",
        path: configPath,
        message: `Config not found: ${toDisplayPath(configPath)}.`,
      });
    }

    return ResultAsync.fromPromise(file.text(), (cause: unknown) => ({
      type: "ConfigReadError" as const,
      path: configPath,
      cause,
      message: `Failed to read config at ${toDisplayPath(configPath)}.`,
    }));
  });
}

function parseProjectConfig(
  source: string,
  configPath: string,
  projectRoot: string,
): Result<WeaveConfig, SpikeComposeError> {
  const parsed = parseConfig(source);

  if (parsed.isErr()) {
    return err({
      type: "ConfigParseError",
      path: configPath,
      errors: parsed.error,
      message: `Failed to parse ${toDisplayPath(configPath)}.`,
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
  // SPIKE: Keep the source prompt/model/tool policy intact while remapping only
  // the logical agent identity used by the harness-facing spike.
  return {
    ...agentConfig,
    name: SOURCE_TO_SPIKE_AGENT_NAME[agentName],
  };
}

function renameDisabledSpikeAgents(disabledAgents: string[]): SpikeAgentName[] {
  const renamedDisabledAgents: SpikeAgentName[] = [];

  for (const agentName of disabledAgents) {
    if (!(agentName in SOURCE_TO_SPIKE_AGENT_NAME)) continue;

    renamedDisabledAgents.push(
      SOURCE_TO_SPIKE_AGENT_NAME[agentName as SourceSpikeAgentName],
    );
  }

  return renamedDisabledAgents;
}

function filterSpikeConfig(
  config: WeaveConfig,
): Result<WeaveConfig, SpikeComposeError> {
  const agents: WeaveConfig["agents"] = {};

  for (const agentName of SOURCE_SPIKE_AGENT_NAMES) {
    const agent = config.agents[agentName];

    if (agent === undefined) {
      return err({
        type: "MissingSpikeAgentError",
        agentName,
        message: `Spike config requires the "${agentName}" agent to be defined.`,
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

function createAdapter(harness: HarnessName): HarnessAdapter {
  if (harness === "opencode") return new OpenCodeAdapter();
  return new PiAdapter();
}

function composeSpikeDescriptors(
  config: WeaveConfig,
): ResultAsync<AgentDescriptor[], SpikeComposeError> {
  const activeAgents = Object.entries(config.agents).filter(
    ([name]: [string, WeaveConfig["agents"][string]]) =>
      !config.disabled.agents.includes(name),
  );

  return ResultAsync.fromPromise(
    Promise.all(
      activeAgents.map(async ([name, agentConfig]) => ({
        agentName: name,
        result: await composeAgentDescriptor(name, agentConfig, config),
      })),
    ),
    (cause: unknown) => ({
      type: "DescriptorComposeError" as const,
      agentName: "<all>",
      cause,
      message: "Failed to compose spike agent descriptors.",
    }),
  ).andThen(
    (
      results: { agentName: string; result: Result<AgentDescriptor, unknown> }[],
    ) => {
      const descriptors: AgentDescriptor[] = [];

      for (const result of results) {
        if (result.result.isErr()) {
          return errAsync<AgentDescriptor[], SpikeComposeError>({
            type: "DescriptorComposeError",
            agentName: result.agentName,
            cause: result.result.error,
            message: `Failed to compose descriptor for spike agent "${result.agentName}".`,
          });
        }

        descriptors.push(result.result.value);
      }

      return okAsync(descriptors);
    },
  );
}

function buildOpenCodeSummary(
  adapter: HarnessAdapter,
  descriptors: AgentDescriptor[],
): ResultAsync<SpikeComposeSummary, SpikeComposeError> {
  const openCodeAdapter = adapter as OpenCodeAdapter;
  const hooks = openCodeAdapter.toPlugin();

  if (hooks.config === undefined) {
    return errAsync({
      type: "OpenCodeConfigHookMissingError",
      message: "OpenCode plugin did not expose a config hook.",
    });
  }

  const pluginConfig: Record<string, unknown> = {};

  return ResultAsync.fromPromise(hooks.config(pluginConfig), (cause: unknown) => ({
    type: "OpenCodeConfigHookExecutionError" as const,
    cause,
    message: "Failed to execute the OpenCode config hook.",
  })).map(
    (): SpikeComposeSummary => ({
      harness: "opencode",
      descriptors,
      registration: {
        kind: "opencode",
        pluginConfig,
      },
    }),
  );
}

function buildPiSummary(
  adapter: HarnessAdapter,
  descriptors: AgentDescriptor[],
): ResultAsync<SpikeComposeSummary, SpikeComposeError> {
  const piAdapter = adapter as PiAdapter;
  const extensionFactory = piAdapter.toExtension();
  const registeredTools: string[] = [];
  const registeredEvents: string[] = [];

  const mockPiApi: PiExtensionAPI = {
    on(event: "before_agent_start", _handler): void {
      registeredEvents.push(event);
    },
    registerTool(tool: { name?: string }): void {
      if (typeof tool.name === "string") registeredTools.push(tool.name);
    },
    setActiveTools(_tools: string[]): void {},
    exec(
      command: string,
      args: string[],
      options?: unknown,
    ): Promise<{ command: string; args: string[]; options?: unknown }> {
      return Promise.resolve({ command, args, options });
    },
  };

  const runExtensionFactory = ResultAsync.fromThrowable(
    (pi: PiExtensionAPI) => Promise.resolve(extensionFactory(pi)),
    (cause: unknown) => ({
      type: "PiExtensionExecutionError" as const,
      cause,
      message: "Failed to execute the Pi extension factory.",
    }),
  );

  return runExtensionFactory(mockPiApi).map(
    (): SpikeComposeSummary => ({
      harness: "pi",
      descriptors,
      registration: {
        kind: "pi",
        registeredAgents: descriptors.map(
          (descriptor: AgentDescriptor) => descriptor.name,
        ),
        registeredTools,
        registeredEvents,
      },
    }),
  );
}

function buildHarnessSummary(
  harness: HarnessName,
  adapter: HarnessAdapter,
  descriptors: AgentDescriptor[],
): ResultAsync<SpikeComposeSummary, SpikeComposeError> {
  if (harness === "opencode") {
    return buildOpenCodeSummary(adapter, descriptors);
  }

  return buildPiSummary(adapter, descriptors);
}

function runSpikeCompose(
  argv: string[],
  projectRoot: string,
): ResultAsync<SpikeComposeSummary, SpikeComposeError> {
  const harnessResult = parseHarnessArg(argv);
  if (harnessResult.isErr()) return errAsync(harnessResult.error);

  const configPath = resolve(projectRoot, ".weave", "config.weave");
  const harness = harnessResult.value;

  return readConfigSource(configPath)
    .andThen((source: string) => {
      const configResult = parseProjectConfig(source, configPath, projectRoot);
      if (configResult.isErr()) return errAsync(configResult.error);

      const filteredConfigResult = filterSpikeConfig(configResult.value);
      if (filteredConfigResult.isErr()) {
        return errAsync(filteredConfigResult.error);
      }

      const filteredConfig = filteredConfigResult.value;
      const adapter = createAdapter(harness);
      const runner = new WeaveRunner(filteredConfig, adapter);

      return composeSpikeDescriptors(filteredConfig)
        .andThen((descriptors: AgentDescriptor[]) =>
          ResultAsync.fromPromise(runner.run(), (cause: unknown) => ({
            type: "RunnerExecutionError" as const,
            harness,
            cause,
            message: `Failed to compose spike agents for harness "${harness}".`,
          })).andThen(() => buildHarnessSummary(harness, adapter, descriptors)),
        );
    })
    ;
}

function formatDescriptorSummary(descriptor: AgentDescriptor): string {
  const model = descriptor.models[0] ?? "<none>";
  const delegationTargets =
    descriptor.delegationTargets.length > 0
      ? descriptor.delegationTargets
          .map((target) => target.name)
          .join(", ")
      : "none";
  const toolPolicy = JSON.stringify(descriptor.toolPolicy);

  return `  - ${descriptor.name}: mode=${descriptor.mode}, model=${model}, delegate_to=${delegationTargets}, tools=${toolPolicy}`;
}

function printSummary(summary: SpikeComposeSummary): void {
  writeStdout(`✓ Composed ${summary.descriptors.length} spike agent descriptors for ${summary.harness}.\n`);
  writeStdout("\nComposed descriptors:\n");

  for (const descriptor of summary.descriptors) {
    writeStdout(`${formatDescriptorSummary(descriptor)}\n`);
  }

  writeStdout("\nHarness materialisation:\n");

  if (summary.registration.kind === "opencode") {
    writeStdout("  - Created OpenCode plugin hooks\n");
    writeStdout("  - Simulated hooks.config({}) mutation result:\n");
    writeStdout(`${JSON.stringify(summary.registration.pluginConfig, null, 2)}\n`);
    writeStdout("  - No files generated; agents are registered through config mutation\n");
    return;
  }

  writeStdout("  - Created Pi extension factory\n");
  writeStdout(
    `  - Agents available to the extension: ${summary.registration.registeredAgents.join(", ")}\n`,
  );
  writeStdout(
    `  - Registered tools: ${summary.registration.registeredTools.join(", ") || "none"}\n`,
  );
  writeStdout(
    `  - Registered hook events: ${summary.registration.registeredEvents.join(", ") || "none"}\n`,
  );
  writeStdout("  - No files generated; agents are registered through extension startup\n");
}

function printError(error: SpikeComposeError): void {
  writeStderr(`✗ ${error.message}\n`);

  if (error.type === "ConfigParseError") {
    writeStderr("\n");

    for (const configError of error.errors) {
      writeStderr(`  ${formatError(configError)}\n`);
    }

    return;
  }
}

if (import.meta.main) {
  const projectRoot = process.cwd();

  await runSpikeCompose(process.argv.slice(2), projectRoot).match(
    (summary: SpikeComposeSummary) => {
      printSummary(summary);
    },
    (error: SpikeComposeError) => {
      printError(error);
      process.exit(1);
    },
  );
}
