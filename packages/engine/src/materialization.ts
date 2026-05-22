import type { AgentConfig, WeaveConfig } from "@weave/core";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import {
  type AgentDescriptor,
  type ComposeError,
  composeAgentDescriptor,
} from "./compose.js";
import {
  type CategoryShuttleConflictError,
  type GeneratedCategoryShuttle,
  generateCategoryShuttles,
} from "./descriptors.js";

/** Adapter-provided input for public agent materialization. */
export interface MaterializationInput {
  /** Fully resolved and validated Weave configuration. */
  config: WeaveConfig;
}

/** A composed agent descriptor paired with its deterministic materialization key. */
export interface MaterializedAgent {
  /** Agent name from the resolved config or generated category shuttle name. */
  agentName: string;
  /** Adapter-facing descriptor with rendered prompt and normalized metadata. */
  descriptor: AgentDescriptor;
}

/** Deterministically ordered adapter-facing materialization output. */
export interface MaterializationPlan {
  /** Ordered resolved agents, preserving config order followed by generated shuttles. */
  agents: MaterializedAgent[];
}

/** Public materialization failures exposed to adapters. */
export type MaterializationError =
  | {
      type: "CategoryShuttleConflict";
      conflict: CategoryShuttleConflictError;
    }
  | {
      type: "DescriptorCompositionFailure";
      agentName: string;
      cause: ComposeError;
    };

function mergeMaterializableAgents(
  config: WeaveConfig,
  generatedShuttles: Record<string, GeneratedCategoryShuttle>,
): Record<string, AgentConfig> {
  const explicitAgents = Object.fromEntries(
    Object.entries(config.agents).filter(
      ([agentName]) => !config.disabled.agents.includes(agentName),
    ),
  );

  const generatedAgentConfigs = Object.fromEntries(
    Object.entries(generatedShuttles).map(([agentName, generated]) => [
      agentName,
      generated.config,
    ]),
  );

  return {
    ...explicitAgents,
    ...generatedAgentConfigs,
  };
}

/**
 * Compose all adapter-facing agent descriptors from a resolved Weave config.
 *
 * The plan order is deterministic: explicit agents keep resolved config order,
 * followed by generated category shuttle agents in category declaration order.
 */
export function materializeAgents(
  input: MaterializationInput,
): ResultAsync<MaterializationPlan, MaterializationError> {
  const generatedShuttlesResult = generateCategoryShuttles(input.config);

  if (generatedShuttlesResult.isErr()) {
    return errAsync({
      type: "CategoryShuttleConflict",
      conflict: generatedShuttlesResult.error,
    });
  }

  const allAgents = mergeMaterializableAgents(
    input.config,
    generatedShuttlesResult.value,
  );
  const materializedAgents: MaterializedAgent[] = [];

  let plan = okAsync<MaterializationPlan, MaterializationError>({ agents: [] });

  for (const [agentName, agentConfig] of Object.entries(allAgents)) {
    const category = generatedShuttlesResult.value[agentName]?.categoryMeta;

    plan = plan.andThen(() =>
      composeAgentDescriptor(
        agentName,
        agentConfig,
        input.config,
        allAgents,
        category,
      )
        .mapErr(
          (cause): MaterializationError => ({
            type: "DescriptorCompositionFailure",
            agentName,
            cause,
          }),
        )
        .map((descriptor): MaterializationPlan => {
          materializedAgents.push({ agentName, descriptor });
          return { agents: [...materializedAgents] };
        }),
    );
  }

  return plan;
}
