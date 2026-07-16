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
  Part,
} from "./sdk-types.js";

/**
 * Minimal shape of the assistant message info returned by `session.prompt()`.
 *
 * The full SDK `AssistantMessage` has many required fields (id, sessionID, time, etc.)
 * that are not relevant to the adapter's review fan-out logic. Using this local
 * type keeps the facade and its mocks decoupled from SDK version churn while
 * preserving the structural contract that matters: the info object has an
 * optional `error` field and is otherwise opaque to the facade callers.
 */
export type PromptSessionInfo = Record<string, unknown> & {
  error?: unknown;
};

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
    }
  | {
      type: "CreateAgentError";
      agentName: string;
      message: string;
    }
  | {
      type: "UpdateAgentError";
      agentName: string;
      message: string;
    }
  | {
      type: "CreateSessionError";
      message: string;
    }
  | {
      type: "PromptSessionError";
      sessionId: string;
      message: string;
    }
  | {
      type: "DeleteSessionError";
      sessionId: string;
      message: string;
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

  /**
   * Creates a new session in the running OpenCode instance for use as a
   * review sub-session during fan-out execution.
   *
   * Corresponds to `client.session.create({ body: { title } })`.
   *
   * @param title - Human-readable title for the session (e.g. the review variant name).
   */
  createReviewSession(
    title: string,
  ): ResultAsync<{ sessionId: string }, OpenCodeClientError>;

  /**
   * Sends a text prompt to an existing session using the specified agent and
   * waits for the assistant to complete its response.
   *
   * Corresponds to `client.session.prompt()`.
   *
   * @param sessionId - The session to prompt.
   * @param prompt - The user text to send.
   * @param agentName - The agent to use for this prompt.
   */
  promptSession(
    sessionId: string,
    prompt: string,
    agentName: string,
  ): ResultAsync<
    { output: string; assistantMessage: PromptSessionInfo },
    OpenCodeClientError
  >;

  /**
   * Deletes a session after review fan-out is complete.
   *
   * Corresponds to `client.session.delete()`.
   *
   * @param sessionId - The session to delete.
   */
  deleteSession(sessionId: string): ResultAsync<void, OpenCodeClientError>;
}

// ---------------------------------------------------------------------------
// Error serialization helper
// ---------------------------------------------------------------------------

/**
 * Builds a safe, non-sensitive description of an SDK error for embedding in
 * thrown Error messages.
 *
 * Never includes `message`, stack, cause, response body, or any field that
 * may contain request payloads, prompts, or model output. Only structural
 * fields (`name`, `statusCode`, `status`, `code`) are included when present.
 *
 * Examples:
 *   `SDK error (name=BadRequest, status=400)`
 *   `SDK error`
 */
function sanitizeSdkError(error: unknown): string {
  if (error === null || error === undefined) return "SDK error";
  if (typeof error !== "object") return "SDK error";
  const e = error as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof e.name === "string") parts.push(`name=${e.name}`);
  if (typeof e.statusCode === "number" || typeof e.statusCode === "string")
    parts.push(`statusCode=${e.statusCode}`);
  if (typeof e.status === "number" || typeof e.status === "string")
    parts.push(`status=${e.status}`);
  if (typeof e.code === "string" || typeof e.code === "number")
    parts.push(`code=${e.code}`);
  return parts.length > 0 ? `SDK error (${parts.join(", ")})` : "SDK error";
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
            `app.agents() returned error: ${sanitizeSdkError(res.error)}`,
          );
        }
        return res.data ?? [];
      }),
      (cause) => ({
        type: "ListAgentsError" as const,
        message: sanitizeSdkError(cause),
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
              `config.update() returned error: ${sanitizeSdkError(res.error)}`,
            );
          }
        }),
      (cause) => ({
        type: "CreateAgentError" as const,
        agentName: name,
        message: sanitizeSdkError(cause),
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
              `config.update() returned error: ${sanitizeSdkError(res.error)}`,
            );
          }
        }),
      (cause) => ({
        type: "UpdateAgentError" as const,
        agentName: name,
        message: sanitizeSdkError(cause),
      }),
    );
  }

  createReviewSession(
    title: string,
  ): ResultAsync<{ sessionId: string }, OpenCodeClientError> {
    return ResultAsync.fromPromise(
      this.client.session.create({ body: { title } }).then((res) => {
        if (res.error !== undefined) {
          throw new Error(
            `session.create() returned error: ${sanitizeSdkError(res.error)}`,
          );
        }
        if (res.data === undefined) {
          throw new Error("session.create() returned no data");
        }
        return { sessionId: res.data.id };
      }),
      (cause) => ({
        type: "CreateSessionError" as const,
        message: sanitizeSdkError(cause),
      }),
    );
  }

  promptSession(
    sessionId: string,
    prompt: string,
    agentName: string,
  ): ResultAsync<
    { output: string; assistantMessage: PromptSessionInfo },
    OpenCodeClientError
  > {
    return ResultAsync.fromPromise(
      this.client.session
        .prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: "text", text: prompt }],
            agent: agentName,
          },
        })
        .then((res) => {
          if (res.error !== undefined) {
            throw new Error(
              `session.prompt() returned error: ${sanitizeSdkError(res.error)}`,
            );
          }
          if (res.data === undefined) {
            throw new Error("session.prompt() returned no data");
          }
          const { info, parts } = res.data;
          if (info.error !== undefined) {
            throw new Error(
              `Assistant returned error: ${sanitizeSdkError(info.error)}`,
            );
          }
          const output = (parts as Part[])
            .filter(
              (p): p is Part & { type: "text"; text: string } =>
                p.type === "text",
            )
            .map((p) => (p as { text: string }).text)
            .join("");
          return { output, assistantMessage: info };
        }),
      (cause) => ({
        type: "PromptSessionError" as const,
        sessionId,
        message: sanitizeSdkError(cause),
      }),
    );
  }

  deleteSession(sessionId: string): ResultAsync<void, OpenCodeClientError> {
    return ResultAsync.fromPromise(
      this.client.session.delete({ path: { id: sessionId } }).then((res) => {
        if (res.error !== undefined) {
          throw new Error(
            `session.delete() returned error: ${sanitizeSdkError(res.error)}`,
          );
        }
      }),
      (cause) => ({
        type: "DeleteSessionError" as const,
        sessionId,
        message: sanitizeSdkError(cause),
      }),
    );
  }
}
