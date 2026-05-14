import { readFile } from "node:fs/promises";
import type { AgentConfig, DelegationTrigger, WeaveConfig } from "@weave/core";
import { errAsync, okAsync, ResultAsync, type Result } from "neverthrow";

type AgentMode = NonNullable<AgentConfig["mode"]>;
type ToolPolicy = NonNullable<AgentConfig["tool_policy"]>;

/**
 * A normalized agent description produced by the engine after prompt
 * composition and delegation graph assembly.
 */
export interface AgentDescriptor {
  name: string;
  description?: string;
  /** Full prompt text after file loading and prompt appends. */
  composedPrompt: string;
  /** Ordered model preference list for adapter-side resolution. */
  models: string[];
  mode: AgentMode;
  temperature?: number;
  toolPolicy: ToolPolicy;
  delegationTargets: DelegationTarget[];
}

/**
 * A single agent that may appear in another agent's delegation section.
 */
export interface DelegationTarget {
  name: string;
  description?: string;
  triggers: DelegationTrigger[];
}

/**
 * Errors that can occur while composing normalized agent descriptors.
 */
export type ComposeError =
  | {
      type: "AgentNotFoundError";
      agentName: string;
      message: string;
    }
  | {
      type: "PromptSourceMissingError";
      agentName: string;
      message: string;
    }
  | {
      type: "PromptFileReadError";
      agentName: string;
      promptFilePath: string;
      cause: unknown;
      message: string;
    };

/**
 * Result shape for a future composition entry point that produces a single
 * normalized agent descriptor.
 */
export type ComposeResult = Result<AgentDescriptor, ComposeError>;

function loadPromptSource(
  agentName: string,
  agentConfig: AgentConfig,
): ResultAsync<string, ComposeError> {
  if (agentConfig.prompt !== undefined) return okAsync(agentConfig.prompt);

  if (agentConfig.prompt_file === undefined) {
    return errAsync({
      type: "PromptSourceMissingError",
      agentName,
      message: `Agent "${agentName}" must define either prompt or prompt_file.`,
    });
  }

  return ResultAsync.fromPromise(readFile(agentConfig.prompt_file, "utf-8"), (cause) => ({
    type: "PromptFileReadError" as const,
    agentName,
    promptFilePath: agentConfig.prompt_file ?? "",
    cause,
    message: `Failed to read prompt file for agent "${agentName}": ${agentConfig.prompt_file}`,
  }));
}

function buildDelegationTargets(
  agentName: string,
  agentConfig: AgentConfig,
  config: WeaveConfig,
): DelegationTarget[] {
  if (agentConfig.tool_policy?.delegate !== "allow") return [];

  const targets: DelegationTarget[] = [];

  for (const [targetName, targetConfig] of Object.entries(config.agents)) {
    if (targetName === agentName) continue;
    if (config.disabled.agents.includes(targetName)) continue;

    targets.push({
      name: targetName,
      description: targetConfig.description,
      triggers: targetConfig.triggers ?? [],
    });
  }

  return targets;
}

function formatDelegationSection(targets: DelegationTarget[]): string {
  const lines = ["## Delegation", ""];

  for (const target of targets) {
    let summary = `- ${target.name}`;
    if (target.description !== undefined) {
      summary = `${summary}: ${target.description}`;
    }

    lines.push(summary);

    if (target.triggers.length === 0) {
      lines.push("  - Triggers: none specified");
      continue;
    }

    for (const trigger of target.triggers) {
      lines.push(`  - ${trigger.domain}: ${trigger.trigger}`);
    }
  }

  return lines.join("\n");
}

function composePrompt(
  promptSource: string,
  delegationTargets: DelegationTarget[],
  promptAppend?: string,
): string {
  const sections = [promptSource];

  if (delegationTargets.length > 0) {
    sections.push(formatDelegationSection(delegationTargets));
  }

  if (promptAppend !== undefined) sections.push(promptAppend);

  return sections.join("\n\n");
}

export function composeAgentDescriptor(
  agentName: string,
  agentConfig: AgentConfig,
  config: WeaveConfig,
): ResultAsync<AgentDescriptor, ComposeError> {
  const delegationTargets = buildDelegationTargets(agentName, agentConfig, config);

  return loadPromptSource(agentName, agentConfig).map((promptSource) => {
    // SPIKE: Schema defaults for descriptor normalization are not settled yet,
    // so omitted models/mode/tool_policy normalize conservatively here.
    return {
      name: agentName,
      description: agentConfig.description,
      composedPrompt: composePrompt(
        promptSource,
        delegationTargets,
        agentConfig.prompt_append,
      ),
      models: agentConfig.models ?? [],
      mode: agentConfig.mode ?? "subagent",
      temperature: agentConfig.temperature,
      toolPolicy: agentConfig.tool_policy ?? {},
      delegationTargets,
    };
  });
}
