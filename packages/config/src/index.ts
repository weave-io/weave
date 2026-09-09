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
export type { ParsePlanTasksInput } from "./plan-task-parser.js";
export {
  MAX_PLAN_BYTES,
  MAX_PLAN_NAME_LENGTH,
  MAX_PLAN_TASKS,
  MAX_PLAN_TITLE_LENGTH,
  parsePlanTasks,
} from "./plan-task-parser.js";
export type {
  PlanTaskFileIoError,
  PlanTaskFileReader,
  PlanTaskPathInfo,
} from "./plan-task-reader.js";
export {
  BunPlanTaskFileReader,
  ConfigPlanTaskReader,
} from "./plan-task-reader.js";
export { resolvePromptPaths } from "./resolve.js";
export type { ConfigScope } from "./types.js";
