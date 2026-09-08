/**
 * @weaveio/weave-adapter-opencode
 *
 * Native OpenCode 2 integration and preserved OpenCode library helpers.
 *
 * This package serves two roles:
 *
 * 1. **OpenCode 2 plugin** — When listed in the plural `plugins` field,
 *    OpenCode loads the default `Plugin.define` definition. The exact supported
 *    host is `0.0.0-beta-19086`. The package also ships physical `server.js`,
 *    `rpc.js`, and `tui.js` entries for native host discovery.
 *
 * 2. **Preserved library helpers** — `OpenCodeAdapter` and the V1
 *    reconciliation and workflow helpers remain available to source consumers.
 *    They do not define the OpenCode 2 runtime ABI.
 *
 * ## Installation as an OpenCode plugin
 *
 * Add the package to the `plugins` array in `opencode.jsonc`:
 *
 * ```jsonc
 * // opencode.jsonc
 * {
 *   "plugins": ["@weaveio/weave-adapter-opencode@<exact-version>"]
 * }
 * ```
 *
 * OpenCode loads the package root server definition. The native runtime reads
 * live model and skill catalogs, materializes Weave agents through public host
 * transforms, and exposes separate read-only RPC and CLI UI entries.
 *
 * ## Boundary rule
 *
 * V2 code uses only public `@opencode-ai/client` and `@opencode-ai/plugin`
 * exports. Preserved V1 library code keeps its SDK facade in `./sdk-types`.
 */

// ---------------------------------------------------------------------------
// Adapter class and options
// ---------------------------------------------------------------------------

export type { OpenCodeAdapterOptions } from "./adapter.js";
export { OpenCodeAdapter, OpenCodeAdapterError } from "./adapter.js";

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
// Explicit plan execution helper (/weave:start delivery path)
// ---------------------------------------------------------------------------

export type {
  StartPlanExecutionError,
  StartPlanExecutionInput,
} from "./start-plan-execution.js";
export {
  DEFAULT_EXECUTION_WORKFLOW,
  startPlanExecution,
  WEAVE_START_COMMAND,
  WEAVE_START_LEGACY_COMMAND,
} from "./start-plan-execution.js";

// ---------------------------------------------------------------------------
// Runtime command projection (adapter-owned command handlers and renderers)
// ---------------------------------------------------------------------------

export type {
  AbortExecutionProjectionInput,
  AdvanceStepProjectionInput,
  InspectStatusProjectionInput,
  ProjectionDegraded,
  ProjectionFailure,
  ProjectionResult,
  ProjectionSuccess,
  RuntimeHealthProjectionInput,
  RunWorkflowProjectionInput,
  StartPlanProjectionInput,
} from "./runtime-command-projection.js";
export {
  buildOpenCodeHealthReport,
  createDefaultStore,
  DEGRADED_AFFORDANCES,
  RuntimeCommandProjection,
  WEAVE_COMMAND_LABELS,
} from "./runtime-command-projection.js";

// ---------------------------------------------------------------------------
// Command templates (slash command registration)
// ---------------------------------------------------------------------------

export {
  START_WORK_COMMAND_TEMPLATE,
  WEAVE_START_COMMAND_TEMPLATE,
} from "./command-templates.js";

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

export type { Plugin as OpenCode2Plugin } from "@opencode-ai/plugin/promise/plugin";
export type { OpenCode2Options } from "./v2/options.js";

/**
 * Historical V1 log subpath. The OpenCode 2 plugin uses the shared engine
 * logger and does not redirect logs to this file.
 *
 * @deprecated Preserved for source compatibility with V1 library consumers.
 */
export const DEFAULT_PLUGIN_LOG_SUBPATH = ".weave/weave.log";

/**
 * Default export: the OpenCode 2 native plugin definition.
 *
 * OpenCode loads this as the plugin entry point when `@weaveio/weave-adapter-opencode`
 * is listed in `opencode.jsonc`'s plural `plugins` array.
 */
export {
  server as WeavePluginServer,
  WeavePlugin,
  WeavePlugin as default,
} from "./plugin.js";
