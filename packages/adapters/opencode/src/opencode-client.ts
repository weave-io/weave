/**
 * Adapter-local OpenCode client facade.
 *
 * This module defines the narrow `OpenCodeClientFacade` interface that the
 * adapter uses to interact with a running OpenCode instance. All SDK-backed
 * agent list/create/update operations flow through this interface so that the
 * exact SDK method names and shapes remain adapter-local and can evolve
 * without changing engine-facing contracts.
 *
 * Boundary rule: this module imports SDK types only through `./sdk-types`.
 * It must not import directly from `@opencode-ai/sdk`.
 *
 * Design notes:
 * - `listAgents()` returns the live agent list from the running OpenCode
 *   instance via `client.app.agents()`.
 * - `createAgent(name, config)` and `updateAgent(name, config)` both write
 *   through `client.config.update()` by patching the `agent` map in the
 *   current config. OpenCode has no separate create/update agent endpoint;
 *   both operations are expressed as a config patch.
 * - The facade does not perform reconciliation logic — that belongs in
 *   `reconcile-agent.ts` (task 3). The facade only wraps the raw SDK calls.
 */

import { ResultAsync } from "neverthrow";

import type {
  OpenCodeAgent,
  OpenCodeAgentConfig,
  OpencodeClient,
} from "./sdk-types.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of errors that `OpenCodeClientFacade` methods can return.
 */
export type OpenCodeClientError =
  | {
      type: "ListAgentsError";
      message: string;
      cause?: unknown;
    }
  | {
      type: "CreateAgentError";
      agentName: string;
      message: string;
      cause?: unknown;
    }
  | {
      type: "UpdateAgentError";
      agentName: string;
      message: string;
      cause?: unknown;
    };

// ---------------------------------------------------------------------------
// Facade interface
// ---------------------------------------------------------------------------

/**
 * Narrow adapter-local interface for OpenCode agent operations.
 *
 * Implementations wrap the `OpencodeClient` SDK calls needed for agent
 * materialization. Tests provide a mock implementation without a live
 * OpenCode runtime.
 */
export interface OpenCodeClientFacade {
  /**
   * Returns the current list of agents known to the running OpenCode instance.
   *
   * Corresponds to `client.app.agents()`.
   */
  listAgents(): ResultAsync<OpenCodeAgent[], OpenCodeClientError>;

  /**
   * Creates a new agent in the running OpenCode instance by patching the
   * config's `agent` map with the provided config under `name`.
   *
   * Corresponds to a `client.config.update()` call that merges `{ agent: { [name]: config } }`.
   *
   * @param name - The canonical agent name (used as the config map key).
   * @param config - The translated OpenCode agent config to write.
   */
  createAgent(
    name: string,
    config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError>;

  /**
   * Updates an existing Weave-managed agent in the running OpenCode instance
   * by patching the config's `agent` map.
   *
   * Semantically identical to `createAgent` at the SDK level — both write
   * through `config.update()`. The distinction exists at the reconciliation
   * layer (`reconcile-agent.ts`) where ownership is verified before calling
   * this method.
   *
   * @param name - The canonical agent name (used as the config map key).
   * @param config - The updated OpenCode agent config to write.
   */
  updateAgent(
    name: string,
    config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError>;
}

// ---------------------------------------------------------------------------
// SDK-backed implementation
// ---------------------------------------------------------------------------

/**
 * SDK-backed implementation of `OpenCodeClientFacade`.
 *
 * Wraps an injected `OpencodeClient` instance. Constructed by the adapter
 * during `init()` when a real SDK client is available.
 */
export class SdkOpenCodeClient implements OpenCodeClientFacade {
  constructor(private readonly client: OpencodeClient) {}

  listAgents(): ResultAsync<OpenCodeAgent[], OpenCodeClientError> {
    return ResultAsync.fromPromise(
      this.client.app.agents().then((res) => {
        if (res.error !== undefined) {
          throw new Error(
            `app.agents() returned error: ${JSON.stringify(res.error)}`,
          );
        }
        return res.data ?? [];
      }),
      (cause) => ({
        type: "ListAgentsError" as const,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
    );
  }

  createAgent(
    name: string,
    config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError> {
    return ResultAsync.fromPromise(
      this.client.config
        .update({ body: { agent: { [name]: config } } })
        .then((res) => {
          if (res.error !== undefined) {
            throw new Error(
              `config.update() returned error: ${JSON.stringify(res.error)}`,
            );
          }
        }),
      (cause) => ({
        type: "CreateAgentError" as const,
        agentName: name,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
    );
  }

  updateAgent(
    name: string,
    config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError> {
    return ResultAsync.fromPromise(
      this.client.config
        .update({ body: { agent: { [name]: config } } })
        .then((res) => {
          if (res.error !== undefined) {
            throw new Error(
              `config.update() returned error: ${JSON.stringify(res.error)}`,
            );
          }
        }),
      (cause) => ({
        type: "UpdateAgentError" as const,
        agentName: name,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
    );
  }
}
