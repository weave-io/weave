import type { AgentConfig, WeaveConfig } from "@weave/core";
import { okAsync, ResultAsync } from "neverthrow";

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
  /**
   * Per-agent failures collected during materialization. Values are accumulated
   * rather than returned as a top-level rejection — the ResultAsync only rejects
   * on a truly irrecoverable upstream failure (none currently exist).
   */
  errors: readonly MaterializationError[];
}

/**
 * Public materialization failures exposed to adapters.
 *
 * These values are collected into `MaterializationPlan.errors[]` rather than
 * returned as a top-level ResultAsync rejection. Adapters should inspect
 * `plan.errors` after a successful `materializeAgents` call to detect partial
 * failures.
 */
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

function filterDisabled(
  entries: [string, AgentConfig][],
  disabled: readonly string[],
): [string, AgentConfig][] {
  return entries.filter(([agentName]) => !disabled.includes(agentName));
}

/**
 * Compose all adapter-facing agent descriptors from a resolved Weave config.
 *
 * The plan order is deterministic: explicit agents keep resolved config order,
 * followed by generated category shuttle agents in category declaration order.
 * Disabled agents are filtered before iteration.
 *
 * Per-agent failures are accumulated into `plan.errors[]`. The ResultAsync
 * itself only rejects on a truly irrecoverable upstream failure — currently
 * none exist, so the returned promise always resolves to `ok`.
 */
export function materializeAgents(
  input: MaterializationInput,
): ResultAsync<MaterializationPlan, never> {
  const { config } = input;
  const disabled = config.disabled.agents;

  const generatedShuttlesResult = generateCategoryShuttles(config);

  // CategoryShuttleConflict is a per-agent failure — collect it and continue
  // with an empty generated-shuttle set so explicit agents still materialise.
  const generatedShuttles: Record<string, GeneratedCategoryShuttle> =
    generatedShuttlesResult.isOk() ? generatedShuttlesResult.value : {};

  const conflictErrors: MaterializationError[] = generatedShuttlesResult.isErr()
    ? [
        {
          type: "CategoryShuttleConflict",
          conflict: generatedShuttlesResult.error,
        },
      ]
    : [];

  const explicitEntries = filterDisabled(
    Object.entries(config.agents),
    disabled,
  );

  const generatedEntries = filterDisabled(
    Object.entries(generatedShuttles).map(
      ([agentName, generated]) =>
        [agentName, generated.config] as [string, AgentConfig],
    ),
    disabled,
  );

  const allEntries: [string, AgentConfig][] = [
    ...explicitEntries,
    ...generatedEntries,
  ];

  const allAgents = Object.fromEntries(allEntries);

  const compositionPromises = allEntries.map(([agentName, agentConfig]) => {
    const category = generatedShuttles[agentName]?.categoryMeta;
    return composeAgentDescriptor(
      agentName,
      agentConfig,
      config,
      allAgents,
      category,
    ).match<
      | { ok: true; agentName: string; descriptor: AgentDescriptor }
      | { ok: false; error: MaterializationError }
    >(
      (descriptor) => ({ ok: true, agentName, descriptor }),
      (cause) => ({
        ok: false,
        error: { type: "DescriptorCompositionFailure", agentName, cause },
      }),
    );
  });

  return ResultAsync.fromSafePromise(Promise.all(compositionPromises)).andThen(
    (composed) => {
      const agents: MaterializedAgent[] = [];
      const compositionErrors: MaterializationError[] = [];

      for (const result of composed) {
        if (result.ok) {
          agents.push({
            agentName: result.agentName,
            descriptor: result.descriptor,
          });
        } else {
          compositionErrors.push(result.error);
        }
      }

      const errors: readonly MaterializationError[] = [
        ...conflictErrors,
        ...compositionErrors,
      ];

      return okAsync<MaterializationPlan, never>({ agents, errors });
    },
  );
}
