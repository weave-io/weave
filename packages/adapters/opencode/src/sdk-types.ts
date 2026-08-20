/**
 * Stable re-exports of `@opencode-ai/sdk` types used by the OpenCode adapter.
 *
 * This is the ONLY file in the adapter allowed to import directly from
 * `@opencode-ai/sdk`. All other adapter modules must import from `./sdk-types`
 * to insulate the rest of the adapter from SDK version churn.
 *
 * Only types that the adapter actively uses are re-exported here. Unused SDK
 * types are intentionally omitted to keep the surface minimal.
 *
 * The SDK exposes no provider-acceleration field for agent configuration and
 * no official response-evidence field (`service_tier` or `usage.speed`) on a
 * successful call. Nothing acceleration-related is re-exported here, so the
 * adapter cannot encode a guessed control or read a false application proof.
 */

import type {
  Agent as SdkOpenCodeAgent,
  AgentConfig as SdkOpenCodeAgentConfig,
} from "@opencode-ai/sdk";

/** The action values accepted by OpenCode permission rules. */
export type OpenCodePermissionAction = "allow" | "deny" | "ask";

/**
 * Agent permission shape used by the adapter.
 *
 * OpenCode's public config supports the `task` permission, but the pinned SDK
 * declaration omits that field. Keep the adapter boundary aligned with the
 * harness contract without weakening the rest of the generated type.
 */
export type OpenCodeAgentPermission = NonNullable<
  SdkOpenCodeAgentConfig["permission"]
> & {
  task?: OpenCodePermissionAction;
};

/** JSON-shaped values accepted in an OpenCode agent's options map. */
export type OpenCodeAgentOptionValue =
  | string
  | number
  | boolean
  | null
  | readonly OpenCodeAgentOptionValue[]
  | { readonly [key: string]: OpenCodeAgentOptionValue };

/** Provider/model and adapter metadata stored in an agent's options map. */
export type OpenCodeAgentOptions = Readonly<
  Record<string, OpenCodeAgentOptionValue>
>;

/** OpenCode agent config with the public task permission restored. */
export type OpenCodeAgentConfig = Pick<
  SdkOpenCodeAgentConfig,
  | "model"
  | "temperature"
  | "top_p"
  | "prompt"
  | "tools"
  | "disable"
  | "description"
  | "mode"
  | "color"
  | "maxSteps"
> & {
  options?: OpenCodeAgentOptions;
  permission?: OpenCodeAgentPermission;
};

export type {
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

/** OpenCode agent descriptor returned by the API. */
export type OpenCodeAgent = SdkOpenCodeAgent;

export {
  /**
   * Factory function that creates a pre-configured `OpencodeClient` pointed at
   * the running OpenCode server. Accepts an optional `directory` override.
   */
  createOpencodeClient,
} from "@opencode-ai/sdk";
