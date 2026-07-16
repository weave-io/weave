/**
 * Stable re-exports of `@opencode-ai/sdk` types used by the OpenCode adapter.
 *
 * This is the ONLY file in the adapter allowed to import directly from
 * `@opencode-ai/sdk`. All other adapter modules must import from `./sdk-types`
 * to insulate the rest of the adapter from SDK version churn.
 *
 * Only types that the adapter actively uses are re-exported here. Unused SDK
 * types are intentionally omitted to keep the surface minimal.
 */

export type {
  /**
   * OpenCode agent descriptor as returned by the API — used when reading the
   * current agent list from a running OpenCode instance.
   */
  Agent as OpenCodeAgent,
  /**
   * OpenCode agent configuration shape — used when materialising a Weave
   * `AgentDescriptor` into an OpenCode agent entry.
   */
  AgentConfig as OpenCodeAgentConfig,
  /**
   * Top-level OpenCode config — used when reading or patching the running
   * OpenCode configuration via the SDK client.
   */
  Config as OpenCodeConfig,
  /**
   * OpenCode model descriptor — used for available-model lookup and
   * model-intent resolution.
   */
  Model as OpenCodeModel,
  /**
   * The generated SDK client class — used to communicate with a running
   * OpenCode server instance.
   */
  OpencodeClient,
  /**
   * Client configuration options — used when constructing an `OpencodeClient`.
   */
  OpencodeClientConfig,
  /**
   * OpenCode provider descriptor — used when enumerating available providers
   * and their models.
   */
  Provider as OpenCodeProvider,
  /**
   * OpenCode session descriptor — used when querying active sessions.
   */
  Session as OpenCodeSession,
} from "@opencode-ai/sdk";

export {
  /**
   * Factory function that creates a pre-configured `OpencodeClient` pointed at
   * the running OpenCode server. Accepts an optional `directory` override.
   */
  createOpencodeClient,
} from "@opencode-ai/sdk";
