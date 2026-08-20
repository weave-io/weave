/**
 * Adapter-local reconciliation logic for Weave-managed OpenCode agents.
 *
 * Reconciliation uses the canonical agent name for lookup and the durable
 * identity stored in OpenCode's agent `options` object for update authority.
 * The human-readable description tag is presentation metadata only.
 *
 * Boundary rule: this module imports SDK types only through `./sdk-types` and
 * the client facade only through `./opencode-client`. It must not import
 * directly from `@opencode-ai/sdk`.
 */

import { errAsync, type ResultAsync } from "neverthrow";

import {
  createWeaveAgentIdentity,
  type OpenCodeAgentIdentity,
  type OpenCodeAgentSummary,
  type OpenCodeClientError,
  type OpenCodeClientFacade,
  openCodeClientDiagnosticMessage,
  WEAVE_AGENT_IDENTITY_KEY,
  WEAVE_AGENT_IDENTITY_KIND,
} from "./opencode-client.js";
import type { OpenCodeAgentConfig } from "./sdk-types.js";

// ---------------------------------------------------------------------------
// Ownership marker
// ---------------------------------------------------------------------------

/** Human-readable marker shown in the OpenCode agent description. */
export const WEAVE_OWNERSHIP_TAG = "[weave-managed]";

function isManagedIdentityFor(
  identity: OpenCodeAgentIdentity | undefined,
  agentName: string,
): boolean {
  return (
    identity?.kind === WEAVE_AGENT_IDENTITY_KIND &&
    identity.version === 1 &&
    identity.agentName === agentName
  );
}

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
export type ReconcileDecision = "create" | "update" | "collision";

/**
 * Classifies an agent name against the current OpenCode agent list.
 *
 * A same-named resource is updateable only when its parsed durable identity
 * matches that name. A copied description tag, omitted identity, or identity
 * for a different name remains a collision.
 */
export function classifyExistingAgent(
  agentName: string,
  existingAgents: readonly OpenCodeAgentSummary[],
): ReconcileDecision {
  const existing = existingAgents.find((agent) => agent.name === agentName);
  if (existing === undefined) return "create";

  return isManagedIdentityFor(existing.weaveIdentity, agentName)
    ? "update"
    : "collision";
}

// ---------------------------------------------------------------------------
// Ownership-tagged config builder
// ---------------------------------------------------------------------------

/**
 * Returns a copy of `config` with presentation metadata and a durable
 * adapter-owned identity.
 *
 * The identity is written below OpenCode's persisted `options` boundary. It
 * is independent of the editable description and is the only authority used
 * for subsequent updates.
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

  const options = {
    [WEAVE_AGENT_IDENTITY_KEY]: createWeaveAgentIdentity(agentName),
  };

  return { ...config, description, options };
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Reconciles a translated OpenCode agent config against the current OpenCode
 * agent list, then creates or updates the agent via the injected client.
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
          message: `Agent "${agentName}" already exists in OpenCode but is not Weave-managed. Weave will not overwrite it. Remove the agent manually or rename your Weave agent to resolve the conflict.`,
        });
      }

      const taggedConfig = tagWithOwnership(agentName, config);
      if (decision === "create") {
        return client
          .createAgent(agentName, taggedConfig)
          .mapErr((error): ReconcileAgentError => mapClientError(error));
      }

      return client
        .updateAgent(agentName, taggedConfig)
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
