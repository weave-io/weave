/**
 * Public API for `@weaveio/weave-config`.
 *
 * All consumers should import from this barrel — never from internal modules
 * directly. This keeps the internal structure refactorable without breaking
 * downstream packages.
 */

export { getBuiltinConfig } from "./builtins.js";
export type { DiscoveredConfig, FileReader } from "./discovery.js";
export { discoverAndParse } from "./discovery.js";
export type { ConfigLoadError } from "./errors.js";
export { loadConfig } from "./loader.js";
export type { MergeError, WorkflowExtensionError } from "./merge.js";
export { mergeConfigs, mergeConfigsResult, mergeWorkflow } from "./merge.js";
export { normalizePath } from "./normalize-path.js";
export { BunFilesystemPlanStateProvider } from "./plan-state-provider.js";
export { resolvePromptPaths } from "./resolve.js";
export type { ConfigScope } from "./types.js";
