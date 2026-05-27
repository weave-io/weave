/**
 * Adapter-local reconciliation logic for Weave-managed OpenCode agents.
 *
 * This module encapsulates the `list existing → reconcile decision →
 * create/update call` flow that `spawnSubagent()` uses to materialize a Weave
 * agent into a running OpenCode instance.
 *
 * ## Reconciliation flow
 *
 * ```
 * 1. listAgents()          — fetch the current agent list from OpenCode
 * 2. find by name          — look for an existing agent whose name matches
 *                            descriptor.name (the Canonical Agent Name)
 * 3. ownership check       — if found, verify the agent is Weave-managed
 *                            (presence of WEAVE_OWNERSHIP_TAG in description)
 * 4. create or update      — call createAgent() for new agents, updateAgent()
 *                            for existing Weave-managed agents
 * 5. collision error       — return ReconcileCollisionError when a same-named
 *                            foreign agent is found (no forced takeover)
 * ```
 *
 * ## Ownership marker
 *
 * Weave marks every agent it creates by embedding `WEAVE_OWNERSHIP_TAG` in the
 * agent's `description` field. This is a lightweight, human-readable signal
 * that lets the reconciler distinguish Weave-managed agents from manually
 * created ones without requiring a separate metadata store.
 *
 * The tag is appended to the description when the agent is first created and
 * checked on every subsequent reconciliation pass. Agents without the tag are
 * treated as foreign and protected from overwrite.
 *
 * ## First-slice constraints
 *
 * - Upsert-only: no automatic delete, prune, or forced takeover.
 * - Collision errors are returned as typed `Result` values — callers decide
 *   how to surface them.
 *
 * Boundary rule: this module imports SDK types only through `./sdk-types` and
 * the client facade only through `./opencode-client`. It must not import
 * directly from `@opencode-ai/sdk`.
 */

import { err, ok, type ResultAsync } from "neverthrow";

import type {
  OpenCodeClientError,
  OpenCodeClientFacade,
} from "./opencode-client.js";
import type { OpenCodeAgent, OpenCodeAgentConfig } from "./sdk-types.js";

// ---------------------------------------------------------------------------
// Ownership marker
// ---------------------------------------------------------------------------

/**
 * Ownership tag embedded in the `description` of every Weave-managed agent.
 *
 * The tag is a short, human-readable string that signals to the reconciler
 * (and to human operators) that the agent was created by Weave. It is
 * intentionally visible in the OpenCode UI so users know which agents are
 * managed by Weave.
 */
export const WEAVE_OWNERSHIP_TAG = "[weave-managed]";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of errors that `reconcileAgent` can return.
 */
export type ReconcileAgentError =
  | {
      /** Listing the current OpenCode agents failed. */
      type: "ListAgentsError";
      message: string;
      cause?: unknown;
    }
  | {
      /** Creating a new agent in OpenCode failed. */
      type: "CreateAgentError";
      agentName: string;
      message: string;
      cause?: unknown;
    }
  | {
      /** Updating an existing Weave-managed agent in OpenCode failed. */
      type: "UpdateAgentError";
      agentName: string;
      message: string;
      cause?: unknown;
    }
  | {
      /**
       * A same-named agent exists in OpenCode but is not Weave-managed.
       * Weave refuses to overwrite it without explicit ownership.
       */
      type: "CollisionError";
      agentName: string;
      message: string;
    };

// ---------------------------------------------------------------------------
// Reconciliation decision
// ---------------------------------------------------------------------------

/**
 * The decision produced by `classifyExistingAgent`.
 *
 * - `"create"` — no existing agent with this name; create a new one.
 * - `"update"` — an existing Weave-managed agent was found; update it.
 * - `"collision"` — a same-named foreign agent was found; refuse to overwrite.
 */
export type ReconcileDecision = "create" | "update" | "collision";

/**
 * Classifies the reconciliation decision for a given agent name against the
 * current OpenCode agent list.
 *
 * @param agentName - The Canonical Agent Name to look up.
 * @param existingAgents - The current list of agents from OpenCode.
 * @returns The reconciliation decision.
 */
export function classifyExistingAgent(
  agentName: string,
  existingAgents: OpenCodeAgent[],
): ReconcileDecision {
  const existing = existingAgents.find((a) => a.name === agentName);

  if (existing === undefined) return "create";

  const description = existing.description ?? "";
  if (description.includes(WEAVE_OWNERSHIP_TAG)) return "update";

  return "collision";
}

// ---------------------------------------------------------------------------
// Ownership-tagged config builder
// ---------------------------------------------------------------------------

/**
 * Returns a copy of `config` with `WEAVE_OWNERSHIP_TAG` appended to the
 * `description` field.
 *
 * The tag is appended only when it is not already present, so calling this
 * function on an already-tagged config is idempotent.
 *
 * @param config - The translated OpenCode agent config.
 * @returns A new config object with the ownership tag in `description`.
 */
export function tagWithOwnership(
  config: OpenCodeAgentConfig,
): OpenCodeAgentConfig {
  const existing = config.description ?? "";
  if (existing.includes(WEAVE_OWNERSHIP_TAG)) return config;

  const tagged =
    existing.length > 0
      ? `${existing} ${WEAVE_OWNERSHIP_TAG}`
      : WEAVE_OWNERSHIP_TAG;

  return { ...config, description: tagged };
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Reconciles a translated OpenCode agent config against the current OpenCode
 * agent list, then creates or updates the agent via the injected client.
 *
 * ## Flow
 *
 * 1. Call `client.listAgents()` to fetch the current agent list.
 * 2. Classify the reconciliation decision using `classifyExistingAgent`.
 * 3. Tag the config with `WEAVE_OWNERSHIP_TAG` before writing.
 * 4. Call `client.createAgent()` or `client.updateAgent()` based on the
 *    decision.
 * 5. Return `err(CollisionError)` when a foreign agent blocks the write.
 *
 * @param agentName - The Canonical Agent Name (matches `descriptor.name`).
 * @param config - The translated OpenCode agent config to materialize.
 * @param client - The injected `OpenCodeClientFacade` to use for SDK calls.
 * @returns `ok(void)` on success, or `err(ReconcileAgentError)` on failure.
 */
export function reconcileAgent(
  agentName: string,
  config: OpenCodeAgentConfig,
  client: OpenCodeClientFacade,
): ResultAsync<void, ReconcileAgentError> {
  return client
    .listAgents()
    .mapErr(
      (e): ReconcileAgentError => ({
        type: "ListAgentsError",
        message: e.message,
        cause: (e as { cause?: unknown }).cause,
      }),
    )
    .andThen((existingAgents) => {
      const decision = classifyExistingAgent(agentName, existingAgents);

      if (decision === "collision") {
        return err<void, ReconcileAgentError>({
          type: "CollisionError",
          agentName,
          message: `Agent "${agentName}" already exists in OpenCode but is not Weave-managed. Weave will not overwrite it. Remove the agent manually or rename your Weave agent to resolve the conflict.`,
        });
      }

      const taggedConfig = tagWithOwnership(config);

      if (decision === "create") {
        return client
          .createAgent(agentName, taggedConfig)
          .mapErr((e): ReconcileAgentError => mapClientError(e));
      }

      // decision === "update"
      return client
        .updateAgent(agentName, taggedConfig)
        .mapErr((e): ReconcileAgentError => mapClientError(e));
    });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Maps an `OpenCodeClientError` to a `ReconcileAgentError`.
 *
 * Used to convert facade-layer errors into reconciliation-layer errors while
 * preserving the original cause for debugging.
 */
function mapClientError(e: OpenCodeClientError): ReconcileAgentError {
  if (e.type === "CreateAgentError") {
    return {
      type: "CreateAgentError",
      agentName: e.agentName,
      message: e.message,
      cause: e.cause,
    };
  }
  if (e.type === "UpdateAgentError") {
    return {
      type: "UpdateAgentError",
      agentName: e.agentName,
      message: e.message,
      cause: e.cause,
    };
  }
  // ListAgentsError should not reach here (handled above), but satisfy TS
  return {
    type: "ListAgentsError",
    message: e.message,
    cause: (e as { cause?: unknown }).cause,
  };
}
