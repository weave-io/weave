import { readFile } from "node:fs/promises";
import type {
  AgentConfig,
  DelegationTrigger,
  ToolPolicy,
  WeaveConfig,
} from "@weave/core";
import { errAsync, okAsync, ResultAsync } from "neverthrow";

import {
  type EffectiveToolPolicy,
  evaluateEffectiveToolPolicy,
} from "./tool-policy.js";

type AgentMode = NonNullable<AgentConfig["mode"]>;

export interface AgentDescriptor {
  name: string;
  description?: string;
  composedPrompt: string;
  models: string[];
  mode: AgentMode;
  temperature?: number;
  effectiveToolPolicy: EffectiveToolPolicy;
  rawToolPolicy: ToolPolicy | undefined;
  delegationTargets: DelegationTarget[];
  skills: string[];
}

export interface DelegationTarget {
  name: string;
  description?: string;
  triggers: DelegationTrigger[];
}

export type ComposeError =
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

  const promptFilePath = agentConfig.prompt_file;

  return ResultAsync.fromPromise(
    readFile(promptFilePath, "utf-8"),
    (cause) => ({
      type: "PromptFileReadError" as const,
      agentName,
      promptFilePath,
      cause,
      message:
        `Failed to read prompt file for agent "${agentName}": ` +
        promptFilePath,
    }),
  );
}

function shouldExcludeSharedShuttleTarget(
  agentName: string,
  targetName: string,
): boolean {
  if (!targetName.startsWith("shuttle-")) return false;
  if (agentName === "shuttle") return true;
  return agentName.startsWith("shuttle-");
}

function buildDelegationTargets(
  agentName: string,
  agentConfig: AgentConfig,
  config: WeaveConfig,
  allAgents: Record<string, AgentConfig>,
): DelegationTarget[] {
  if (agentConfig.tool_policy?.delegate !== "allow") return [];

  const targets: DelegationTarget[] = [];

  for (const [targetName, targetConfig] of Object.entries(allAgents)) {
    if (targetName === agentName) continue;
    if (config.disabled.agents.includes(targetName)) continue;
    if (targetConfig.mode === "primary") continue;
    if (shouldExcludeSharedShuttleTarget(agentName, targetName)) continue;

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

    for (const trigger of target.triggers) {
      lines.push(`  - ${trigger.domain}: ${trigger.trigger}`);
    }
  }

  return lines.join("\n");
}

function composePrompt(
  promptSource: string,
  delegationTargets: DelegationTarget[],
  promptAppend: string | undefined,
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
  allAgents: Record<string, AgentConfig>,
): ResultAsync<AgentDescriptor, ComposeError> {
  const delegationTargets = buildDelegationTargets(
    agentName,
    agentConfig,
    config,
    allAgents,
  );

  return loadPromptSource(agentName, agentConfig).map((promptSource) => ({
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
    effectiveToolPolicy: evaluateEffectiveToolPolicy(agentConfig.tool_policy),
    rawToolPolicy: agentConfig.tool_policy,
    delegationTargets,
    skills: agentConfig.skills ?? [],
  }));
}
