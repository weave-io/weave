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
   * Assistant message returned by `session.prompt()` — carries completion
   * status, error details, token usage, cost, and the output `parts` array.
   * Used in the review fan-out executor to detect success/failure and extract
   * text output after each sub-session prompt completes.
   */
  AssistantMessage,
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
   * Union of all assistant message part types. Used when iterating
   * `AssistantMessage.parts` and narrowing to `TextPart` via type guard.
   */
  Part,
  /**
   * OpenCode provider descriptor — used when enumerating available providers
   * and their models.
   */
  Provider as OpenCodeProvider,
  /**
   * OpenCode session descriptor — used when querying active sessions.
   */
  Session as OpenCodeSession,
  /**
   * Input shape for `session.create()` — specifies the optional parent session
   * ID and title when spawning a new sub-session for each review category
   * during fan-out execution.
   */
  SessionCreateData,
  /**
   * Input shape for `session.prompt()` — specifies the parts (user text),
   * agent, and model to use when sending a prompt to a sub-session during
   * review fan-out execution.
   */
  SessionPromptData,
  /**
   * Text output part from an assistant response — contains the actual review
   * text produced by the model. Filtered out of `AssistantMessage.parts` in
   * the review fan-out executor to assemble the final review body.
   */
  TextPart,
} from "@opencode-ai/sdk";

export {
  /**
   * Factory function that creates a pre-configured `OpencodeClient` pointed at
   * the running OpenCode server. Accepts an optional `directory` override.
   */
  createOpencodeClient,
} from "@opencode-ai/sdk";
