/**
 * Adapter-local reconciliation logic for Weave-managed OpenCode agents.
 *
 * Reconciliation uses the canonical agent name for lookup. OpenCode exposes
 * only user-editable metadata at this seam, so same-name resources are never
 * updated automatically until Weave has an unforgeable ownership authority.
 *
 * Boundary rule: this module imports SDK types only through `./sdk-types` and
 * the client facade only through `./opencode-client`. It must not import
 * directly from `@opencode-ai/sdk`.
 */

import { errAsync, type ResultAsync } from "neverthrow";

import {
  createWeaveAgentIdentity,
  type OpenCodeAgentSummary,
  type OpenCodeClientError,
  type OpenCodeClientFacade,
  openCodeClientDiagnosticMessage,
  WEAVE_AGENT_IDENTITY_KEY,
} from "./opencode-client.js";
import type { OpenCodeAgentConfig } from "./sdk-types.js";

// ---------------------------------------------------------------------------
// Ownership marker
// ---------------------------------------------------------------------------

/** Human-readable marker shown in the OpenCode agent description. */
export const WEAVE_OWNERSHIP_TAG = "[weave-managed]";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Errors returned by adapter-owned reconciliation. */
export type ReconcileAgentError =
  | {
      type: "ListAgentsError";
      operation: "list-agents";
      status: OpenCodeClientError["status"];
      message: string;
    }
  | {
      type: "CreateAgentError";
      operation: "create-agent";
      status: OpenCodeClientError["status"];
      agentName: string;
      message: string;
    }
  | {
      type: "UpdateAgentError";
      operation: "update-agent";
      status: OpenCodeClientError["status"];
      agentName: string;
      message: string;
    }
  | {
      type: "CollisionError";
      agentName: string;
      message: string;
    };

// ---------------------------------------------------------------------------
// Reconciliation decision
// ---------------------------------------------------------------------------

/** The decision produced by `classifyExistingAgent`. */
export type ReconcileDecision = "create" | "collision";

/**
 * Classifies an agent name against the current OpenCode agent list.
 *
 * A same-named resource is always a collision. OpenCode exposes only
 * user-editable configuration metadata at this seam; neither the description
 * tag nor the deterministic `options.weave` identity proves Weave ownership.
 * Automatic updates therefore fail closed until an unforgeable authority is
 * available.
 */
export function classifyExistingAgent(
  agentName: string,
  existingAgents: readonly OpenCodeAgentSummary[],
): ReconcileDecision {
  const existing = existingAgents.find((agent) => agent.name === agentName);
  if (existing === undefined) return "create";
  return "collision";
}

// ---------------------------------------------------------------------------
// Ownership-tagged config builder
// ---------------------------------------------------------------------------

/**
 * Returns a copy of `config` with presentation metadata and deterministic
 * adapter metadata for newly injected agents.
 *
 * The metadata is not update authority. Existing options are retained when
 * the metadata is added so provider/model-specific configuration survives
 * materialization.
 */
export function tagWithOwnership(
  agentName: string,
  config: OpenCodeAgentConfig,
): OpenCodeAgentConfig {
  const existingDescription = config.description ?? "";
  let description = existingDescription;
  if (!existingDescription.includes(WEAVE_OWNERSHIP_TAG)) {
    description =
      existingDescription.length > 0
        ? `${existingDescription} ${WEAVE_OWNERSHIP_TAG}`
        : WEAVE_OWNERSHIP_TAG;
  }

  const existingOptions = config.options;
  const options =
    existingOptions === undefined
      ? { [WEAVE_AGENT_IDENTITY_KEY]: createWeaveAgentIdentity(agentName) }
      : {
          ...existingOptions,
          [WEAVE_AGENT_IDENTITY_KEY]: createWeaveAgentIdentity(agentName),
        };

  return { ...config, description, options };
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Reconciles a translated OpenCode agent config against the current OpenCode
 * agent list, creating only when the canonical name is unused. Same-name
 * resources are refused because ownership cannot be proven.
 */
export function reconcileAgent(
  agentName: string,
  config: OpenCodeAgentConfig,
  client: OpenCodeClientFacade,
): ResultAsync<void, ReconcileAgentError> {
  return client
    .listAgents()
    .mapErr((error): ReconcileAgentError => mapClientError(error))
    .andThen((existingAgents) => {
      const decision = classifyExistingAgent(agentName, existingAgents);

      if (decision === "collision") {
        return errAsync<undefined, ReconcileAgentError>({
          type: "CollisionError",
          agentName,
          message: `Agent "${agentName}" already exists in OpenCode, but Weave cannot prove ownership from user-editable metadata. Weave will not overwrite it. Remove the agent manually or rename your Weave agent to resolve the conflict.`,
        });
      }

      const taggedConfig = tagWithOwnership(agentName, config);
      return client
        .createAgent(agentName, taggedConfig)
        .mapErr((error): ReconcileAgentError => mapClientError(error));
    });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Maps a client error without copying its message or any provider data. */
function mapClientError(error: OpenCodeClientError): ReconcileAgentError {
  if (error.type === "CreateAgentError") {
    return {
      type: "CreateAgentError",
      operation: error.operation,
      status: error.status,
      agentName: error.agentName,
      message: openCodeClientDiagnosticMessage(error.operation, error.status),
    };
  }

  if (error.type === "UpdateAgentError") {
    return {
      type: "UpdateAgentError",
      operation: error.operation,
      status: error.status,
      agentName: error.agentName,
      message: openCodeClientDiagnosticMessage(error.operation, error.status),
    };
  }

  return {
    type: "ListAgentsError",
    operation: error.operation,
    status: error.status,
    message: openCodeClientDiagnosticMessage(error.operation, error.status),
  };
}
