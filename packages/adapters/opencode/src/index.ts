/**
 * @weave/adapter-opencode
 *
 * OpenCode harness adapter and plugin entry point for the Weave orchestration
 * framework.
 *
 * This package serves two roles:
 *
 * 1. **OpenCode plugin** — When listed in `opencode.json`'s `plugin` array,
 *    OpenCode loads this package at startup and calls the default-exported
 *    `WeavePlugin` function. The plugin materializes all agents declared in
 *    `.weave/config.weave` into the running OpenCode instance.
 *
 * 2. **Harness adapter library** — `OpenCodeAdapter` implements the
 *    `HarnessAdapter` interface and can be used programmatically by any caller
 *    that wants to materialize Weave agents into OpenCode.
 *
 * ## Installation as an OpenCode plugin
 *
 * ```jsonc
 * // opencode.json
 * {
 *   "plugin": ["@weave/adapter-opencode"]
 * }
 * ```
 *
 * Restart OpenCode after adding the plugin. The plugin entry point receives
 * the runtime context, constructs an `OpenCodeAdapter` with the injected SDK
 * client, and materializes all agents declared in `.weave/config.weave`.
 *
 * ## Boundary rule
 *
 * This package is the only consumer of `@opencode-ai/sdk` and
 * `@opencode-ai/plugin`. All SDK type imports flow through `./sdk-types` —
 * never directly from the SDK package. Plugin types are confined to
 * `./plugin.ts`.
 */

// ---------------------------------------------------------------------------
// Adapter class and options
// ---------------------------------------------------------------------------

export type { OpenCodeAdapterOptions } from "./adapter.js";
export { OpenCodeAdapter } from "./adapter.js";

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export type {
  ModelResolutionError,
  OpenCodeModelContext,
} from "./model-resolution.js";
export { resolveModelForAgent } from "./model-resolution.js";

// ---------------------------------------------------------------------------
// SDK client facade
// ---------------------------------------------------------------------------

export type {
  OpenCodeClientError,
  OpenCodeClientFacade,
} from "./opencode-client.js";
export { SdkOpenCodeClient } from "./opencode-client.js";

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type {
  ReconcileAgentError,
  ReconcileDecision,
} from "./reconcile-agent.js";
export {
  classifyExistingAgent,
  reconcileAgent,
  tagWithOwnership,
  WEAVE_OWNERSHIP_TAG,
} from "./reconcile-agent.js";

// ---------------------------------------------------------------------------
// Workflow runner
// ---------------------------------------------------------------------------

export type {
  RunWorkflowError,
  RunWorkflowInput,
  RunWorkflowResult,
} from "./run-workflow.js";
export { runWorkflow } from "./run-workflow.js";

// ---------------------------------------------------------------------------
// Skill discovery helpers
// ---------------------------------------------------------------------------

export {
  buildSkillInfoList,
  validateDeclaredSkills,
} from "./skill-discovery.js";

// ---------------------------------------------------------------------------
// OpenCode plugin entry point
// ---------------------------------------------------------------------------

export type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
/**
 * Default export: the OpenCode `Plugin` function.
 *
 * OpenCode loads this as the plugin entry point when `@weave/adapter-opencode`
 * is listed in `opencode.json`'s `plugin` array.
 */
export {
  server as WeavePluginServer,
  WeavePlugin,
  WeavePlugin as default,
} from "./plugin.js";
