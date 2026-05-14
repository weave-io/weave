import type { AgentDescriptor, HarnessAdapter, HookConfig, SkillConfig } from "@weave/engine";
import { okAsync, type ResultAsync } from "neverthrow";

type OpenCodeToolName = "read" | "write" | "execute";
type OpenCodeToolPermissions = Partial<Record<OpenCodeToolName, boolean>>;
type OpenCodeAgentConfig = {
  description?: string;
  prompt: string;
  mode: "primary" | "subagent";
  model?: string;
  temperature?: number;
  tools?: OpenCodeToolPermissions;
};

// SPIKE: Minimal OpenCode plugin hooks shape until the real plugin package is
// introduced as a dependency.
export interface OpenCodePluginHooks {
  config?: (cfg: Record<string, any>) => Promise<void>;
}

function mapMode(mode: AgentDescriptor["mode"]): "primary" | "subagent" {
  // SPIKE: OpenCode has no `all` mode, so the spike collapses `all` into the
  // closest concrete runtime mode: `primary`.
  if (mode === "all") return "primary";
  return mode;
}

function mapTools(toolPolicy: AgentDescriptor["toolPolicy"]): OpenCodeToolPermissions {
  const tools: OpenCodeToolPermissions = {};

  if (toolPolicy.read === "allow") tools.read = true;
  if (toolPolicy.read === "deny") tools.read = false;

  if (toolPolicy.write === "allow") tools.write = true;
  if (toolPolicy.write === "deny") tools.write = false;

  if (toolPolicy.execute === "allow") tools.execute = true;
  if (toolPolicy.execute === "deny") tools.execute = false;

  // SPIKE: OpenCode agent config currently uses boolean tool permissions, so
  // Weave's `ask`, `network`, and `delegate` intents are omitted here.
  return tools;
}

function toOpenCodeAgentConfig(descriptor: AgentDescriptor): OpenCodeAgentConfig {
  const tools = mapTools(descriptor.toolPolicy);

  return {
    description: descriptor.description,
    prompt: descriptor.composedPrompt,
    mode: mapMode(descriptor.mode),
    model: descriptor.models[0],
    temperature: descriptor.temperature,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
  };
}

// SPIKE: Treat this class as sealed; TypeScript cannot enforce `sealed`, so it
// is exported as a concrete class with no subclassing intended.
export class OpenCodeAdapter implements HarnessAdapter {
  private readonly agents = new Map<string, AgentDescriptor>();

  init(): Promise<void> {
    return Promise.resolve();
  }

  spawnSubagent(name: string, descriptor: AgentDescriptor): Promise<void> {
    return this.collectAgentDescriptor(name, descriptor).match(
      () => undefined,
      () => undefined,
    );
  }

  registerHook(_hook: HookConfig): Promise<void> {
    // SPIKE: Hook registration is out of scope for the OpenCode adapter spike.
    return Promise.resolve();
  }

  loadSkill(_skill: SkillConfig): Promise<void> {
    // SPIKE: Skill loading is out of scope for the OpenCode adapter spike.
    return Promise.resolve();
  }

  toPlugin(): OpenCodePluginHooks {
    return {
      config: async (cfg: Record<string, any>) => {
        cfg.agent = cfg.agent ?? {};

        for (const [name, descriptor] of this.agents) {
          cfg.agent[name] = toOpenCodeAgentConfig(descriptor);
        }
      },
    };
  }

  private collectAgentDescriptor(
    name: string,
    descriptor: AgentDescriptor,
  ): ResultAsync<void, never> {
    this.agents.set(name, descriptor);
    return okAsync(undefined);
  }
}

export default OpenCodeAdapter;
