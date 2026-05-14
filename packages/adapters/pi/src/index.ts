import { logger } from "@weave/engine";
import type { AgentDescriptor, HarnessAdapter, HookConfig, SkillConfig } from "@weave/engine";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import { Type } from "typebox";

const log = logger.child({ module: "adapter-pi" });

// SPIKE: Minimal Pi extension API shape kept local so the adapter does not
// depend on Pi packages during the spike.
export type BeforeAgentStartEvent = {
  type: string;
  prompt: string;
  systemPrompt: string;
  systemPromptOptions: unknown;
  images?: unknown[];
};

export type BeforeAgentStartEventResult = {
  systemPrompt?: string;
};

export type AgentToolResult = {
  content: { type: string; text: string }[];
  details: unknown;
};

export type ExecResult = unknown;

export interface PiExtensionAPI {
  on(
    event: "before_agent_start",
    handler:
      | ((
          event: BeforeAgentStartEvent,
          ctx: unknown,
        ) => Promise<BeforeAgentStartEventResult | void> | BeforeAgentStartEventResult | void),
  ): void;
  registerTool(tool: PiToolDefinition): void;
  setActiveTools(toolNames: string[]): void;
  exec(command: string, args: string[], options?: Record<string, unknown>): Promise<ExecResult>;
}

export type PiExtensionFactory = (pi: PiExtensionAPI) => void | Promise<void>;

type PiAdapterError =
  | {
      type: "AgentDescriptorNameMismatchError";
      agentName: string;
      descriptorName: string;
      message: string;
    }
  | {
      type: "MissingPrimaryAgentDescriptorError";
      message: string;
    }
  | {
      type: "UnknownDelegationTargetError";
      agentName: string;
      message: string;
    }
  | {
      type: "PiExecError";
      agentName: string;
      cause: unknown;
      message: string;
    };

type DelegateToolArgs = {
  agent: string;
  task: string;
};

type PiToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute(
    toolCallId: string,
    params: { agent: string; task: string },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<AgentToolResult>;
};

const PRIMARY_AGENT_NAME = "loom";

function mapTools(toolPolicy: AgentDescriptor["toolPolicy"]): string[] {
  const tools = new Set<string>();

  if (toolPolicy.read === "allow") {
    tools.add("read");
    tools.add("grep");
    tools.add("find");
    tools.add("ls");
  }

  if (toolPolicy.write === "allow") {
    tools.add("write");
    tools.add("edit");
  }

  if (toolPolicy.execute === "allow") tools.add("bash");

  // SPIKE: `delegate` is a Weave-managed custom tool registered by this
  // extension, so it is enabled separately from Pi's built-in tool names.
  if (toolPolicy.delegate === "allow") tools.add("delegate");

  return [...tools];
}

async function buildPiExecArgs(
  descriptor: AgentDescriptor,
  task: string,
): Promise<{ args: string[]; tempPromptFile: string }> {
  const safeAgentName = descriptor.name.replace(/[^a-zA-Z0-9_-]/g, "-");
  const tempDir = await mkdtemp(join(tmpdir(), "weave-pi-"));
  const tempPromptFile = join(tempDir, `${safeAgentName}.txt`);

  await writeFile(tempPromptFile, descriptor.composedPrompt, "utf-8");

  const args = ["--mode", "json", "-p", "--no-session"];

  const selectedModel = descriptor.models[0];
  if (selectedModel !== undefined) {
    args.push("--model", selectedModel);
  }

  args.push(
    "--tools",
    mapTools(descriptor.toolPolicy).join(","),
    "--append-system-prompt",
    tempPromptFile,
  );

  // Sanitize task to prevent argument injection — strip leading dashes so Pi
  // CLI does not interpret the task as a flag. pi.exec() uses an args array
  // (no shell), so only Pi's own option parser is a concern.
  const sanitizedTask = task.replace(/^-+/, "");
  args.push(sanitizedTask);

  return { args, tempPromptFile };
}

export class PiAdapter implements HarnessAdapter {
  private readonly agents = new Map<string, AgentDescriptor>();

  public init(): Promise<void> {
    log.info("Initialising Pi adapter");
    return Promise.resolve();
  }

  public registerHook(hook: HookConfig): Promise<void> {
    log.debug({ hook: hook.name, event: hook.event }, "Pi hook registration is deferred to the extension factory");
    return Promise.resolve();
  }

  public loadSkill(skill: SkillConfig): Promise<void> {
    log.debug({ skill: skill.name, scope: skill.scope }, "Pi skill loading is deferred");
    return Promise.resolve();
  }

  public spawnSubagent(name: string, descriptor: AgentDescriptor): Promise<void> {
    return this.collectAgentDescriptor(name, descriptor).match(
      () => undefined,
      (error) => {
        throw new Error(error.message);
      },
    );
  }

  public toExtension(): PiExtensionFactory {
    return async (pi: PiExtensionAPI) => {
      const primaryDescriptorResult = this.resolvePrimaryDescriptor();
      if (primaryDescriptorResult.isErr()) {
        throw new Error(primaryDescriptorResult.error.message);
      }

      const delegateTool = this.buildDelegateTool(pi);
      pi.registerTool(delegateTool);

      pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: unknown) => {
        return this.configureAgentStart(pi, event, primaryDescriptorResult.value);
      });
    };
  }

  private collectAgentDescriptor(
    name: string,
    descriptor: AgentDescriptor,
  ): ResultAsync<void, PiAdapterError> {
    const validatedDescriptor = this.validateDescriptorName(name, descriptor);
    if (validatedDescriptor.isErr()) return errAsync(validatedDescriptor.error);

    this.agents.set(name, validatedDescriptor.value);
    log.info({ agent: name }, "Collected Pi agent descriptor");
    return okAsync(undefined);
  }

  private validateDescriptorName(
    name: string,
    descriptor: AgentDescriptor,
  ): Result<AgentDescriptor, PiAdapterError> {
    if (descriptor.name === name) return ok(descriptor);

    return err({
      type: "AgentDescriptorNameMismatchError",
      agentName: name,
      descriptorName: descriptor.name,
      message:
        `PiAdapter received mismatched agent names: parameter "${name}" does not match descriptor "${descriptor.name}".`,
    });
  }

  private resolvePrimaryDescriptor(): Result<AgentDescriptor, PiAdapterError> {
    const loomDescriptor = this.agents.get(PRIMARY_AGENT_NAME);
    if (loomDescriptor !== undefined) return ok(loomDescriptor);

    for (const descriptor of this.agents.values()) {
      if (descriptor.mode === "primary") return ok(descriptor);
    }

    for (const descriptor of this.agents.values()) {
      if (descriptor.mode === "all") return ok(descriptor);
    }

    return err({
      type: "MissingPrimaryAgentDescriptorError",
      message: "PiAdapter could not resolve a primary agent descriptor for extension startup.",
    });
  }

  private buildDelegateTool(pi: PiExtensionAPI): PiToolDefinition {
    return {
      name: "delegate",
      label: "Delegate",
      description: "Delegate a task to a Weave-managed subagent.",
      parameters: Type.Object({
        agent: Type.String({ description: "Name of the Weave agent to delegate to." }),
        task: Type.String({ description: "The task to delegate." }),
      }),
      execute: async (
        _toolCallId: string,
        params: DelegateToolArgs,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: unknown,
      ): Promise<AgentToolResult> => {
        const result = await this.delegateToSubagent(pi, params);

        return result.match(
          (value) => ({
            content: [
              {
                type: "text",
                text: JSON.stringify(value) ?? "undefined",
              },
            ],
            details: {},
          }),
          (error) => {
            throw new Error(error.message);
          },
        );
      },
    };
  }

  private delegateToSubagent(
    pi: PiExtensionAPI,
    args: DelegateToolArgs,
  ): ResultAsync<ExecResult, PiAdapterError> {
    const descriptorResult = this.resolveDelegationTarget(args.agent);
    if (descriptorResult.isErr()) return errAsync(descriptorResult.error);

    const descriptor = descriptorResult.value;
    const execDelegation = ResultAsync.fromThrowable(
      async () => {
        const { args: execArgs, tempPromptFile } = await buildPiExecArgs(descriptor, args.task);

        try {
          return await pi.exec("pi", execArgs);
        } finally {
          await rm(dirname(tempPromptFile), { recursive: true, force: true });
        }
      },
      (cause: unknown) => ({
        type: "PiExecError" as const,
        agentName: descriptor.name,
        cause,
        message: `Failed to spawn Pi subprocess for delegated agent "${descriptor.name}".`,
      }),
    );

    log.info({ agent: descriptor.name, tools: mapTools(descriptor.toolPolicy) }, "Delegating task to Pi subprocess");

    return execDelegation();
  }

  private resolveDelegationTarget(agentName: string): Result<AgentDescriptor, PiAdapterError> {
    const descriptor = this.agents.get(agentName);
    if (descriptor !== undefined) return ok(descriptor);

    return err({
      type: "UnknownDelegationTargetError",
      agentName,
      message: `PiAdapter could not find a collected descriptor for delegated agent "${agentName}".`,
    });
  }

  private configureAgentStart(
    pi: PiExtensionAPI,
    event: BeforeAgentStartEvent,
    primaryDescriptor: AgentDescriptor,
  ): BeforeAgentStartEventResult {
    void event;

    const activeTools = mapTools(primaryDescriptor.toolPolicy);

    pi.setActiveTools(activeTools);
    log.info({ agent: primaryDescriptor.name, tools: activeTools }, "Configured Pi tools for agent start");

    return { systemPrompt: primaryDescriptor.composedPrompt };
  }
}

export type { PiAdapterError };

export default PiAdapter;
