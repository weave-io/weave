/**
 * Projection Helpers — adapter-internal shared utilities.
 *
 * Provides the two helpers that are shared across the OpenCode adapter's
 * projection modules:
 *
 * - `buildProjectEffect` — builds the adapter-owned `projectEffect` callback
 *   that calls `adapter.spawnSubagent` for each `DispatchAgentEffect`.
 * - `deriveRunWorkflowResult` — maps `ExecutionStartedData`-shaped data to
 *   the adapter-owned `RunWorkflowResult` discriminated union.
 *
 * ## Boundary rule
 *
 * This module is adapter-internal. It must not be imported by engine packages.
 * It exists solely to eliminate duplication across `run-workflow.ts`,
 * `start-plan-execution.ts`, and `runtime-command-projection.ts`.
 *
 * @see packages/adapters/opencode/src/run-workflow.ts
 * @see packages/adapters/opencode/src/start-plan-execution.ts
 * @see packages/adapters/opencode/src/runtime-command-projection.ts
 * @see docs/adapter-boundary.md
 */

import type { DispatchAgentEffect, WorkflowRunnerError } from "@weaveio/weave-engine";
import { logger } from "@weaveio/weave-engine";
import type { ResultAsync } from "neverthrow";

import type { OpenCodeAdapter } from "./adapter.js";
import type { RunWorkflowResult } from "./run-workflow.js";

const log = logger.child({ module: "projection-helpers" });

// ---------------------------------------------------------------------------
// buildProjectEffect — adapter-owned effect projection callback
// ---------------------------------------------------------------------------

/**
 * Build the adapter-owned `projectEffect` callback for engine operations.
 *
 * The callback calls `adapter.spawnSubagent` for each `DispatchAgentEffect`
 * emitted by the engine's workflow runner. On failure, maps
 * `OpenCodeAdapterError` to `WorkflowRunnerError` so the engine can propagate
 * it as a typed `projection_error`.
 *
 * This is adapter-owned — the engine never calls `spawnSubagent` directly.
 *
 * @param adapter - The OpenCode adapter instance.
 * @returns A `projectEffect` callback suitable for engine operation calls.
 */
export function buildProjectEffect(
  adapter: OpenCodeAdapter,
): (effect: DispatchAgentEffect) => ResultAsync<void, WorkflowRunnerError> {
  return (effect: DispatchAgentEffect) => {
    log.info(
      {
        agentName: effect.runAgent.agentName,
        stepType: effect.runAgent.stepType,
        completionMethod: effect.runAgent.completionMethod,
      },
      "Applying DispatchAgentEffect — spawning subagent",
    );
    return adapter.spawnSubagent(effect.runAgent.agentDescriptor).mapErr(
      (cause): WorkflowRunnerError => ({
        type: "projection_error" as const,
        message: `spawnSubagent failed for agent "${effect.runAgent.agentName}": ${cause.message}`,
        cause,
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// deriveRunWorkflowResult — map ExecutionStartedData to RunWorkflowResult
// ---------------------------------------------------------------------------

/**
 * Derive a `RunWorkflowResult` from the engine's `ExecutionStartedData`.
 *
 * `ExecutionStartedData.effects` carries all lifecycle effects emitted during
 * the run. We derive:
 * - `status`: "paused" if a `pause-execution` effect is present, else "completed".
 * - `stepsDispatched`: count of `dispatch-agent` effects.
 * - `appliedEffects`: all effects (forwarded as-is).
 *
 * @param data - Execution data with a `workflowInstanceId` and `effects` array.
 * @returns A normalized `RunWorkflowResult`.
 */
export function deriveRunWorkflowResult(data: {
  readonly workflowInstanceId: string;
  readonly effects: readonly { readonly kind: string }[];
}): RunWorkflowResult {
  const hasPause = data.effects.some((e) => e.kind === "pause-execution");
  const stepsDispatched = data.effects.filter(
    (e) => e.kind === "dispatch-agent",
  ).length;

  return {
    workflowInstanceId: data.workflowInstanceId,
    appliedEffects: data.effects as RunWorkflowResult["appliedEffects"],
    status: hasPause ? "paused" : "completed",
    stepsDispatched,
  };
}
