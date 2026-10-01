/**
 * Public API for `@weaveio/weave-config`.
 *
 * All consumers should import from this barrel — never from internal modules
 * directly. This keeps the internal structure refactorable without breaking
 * downstream packages.
 */

export { BUILTIN_MODELS_ISSUED, getBuiltinConfig } from "./builtins.js";
export type {
  ConfigLoadDiagnostic,
  ModelRecommendationsSkipReason,
} from "./diagnostics.js";
export { describeModelRecommendationsSkipReason } from "./diagnostics.js";
export type { DiscoveredConfig, FileReader } from "./discovery.js";
export {
  discoverAndParse,
  GLOBAL_CONFIG_DIR_ENV,
  globalConfigDir,
} from "./discovery.js";
export type { ConfigLoadError } from "./errors.js";
export type { LoadConfigOptions, LoadedConfig } from "./loader.js";
export {
  getResolvedBuiltinConfig,
  loadConfig,
  loadConfigDetailed,
} from "./loader.js";
export type { MergeError, WorkflowExtensionError } from "./merge.js";
export { mergeConfigs, mergeConfigsResult, mergeWorkflow } from "./merge.js";
export type {
  ClaudeCodeModelTier,
  ModelRecommendationsEnvelope,
  ModelRecommendationsError,
  ModelRecommendationsFile,
  ModelRecommendationsSection,
  RecommendationsHarness,
  SelectedRecommendationsSection,
} from "./model-recommendations.js";
export {
  CLAUDE_CODE_MODEL_TIERS,
  describeModelRecommendationsError,
  isRecommendationsHarness,
  MAX_MODEL_RECOMMENDATIONS_BYTES,
  MAX_MODEL_RECOMMENDATIONS_EVIDENCE_LENGTH,
  MAX_MODEL_RECOMMENDATIONS_ISSUED_SKEW_MS,
  MAX_MODEL_RECOMMENDATIONS_VALIDITY_MS,
  MAX_RECOMMENDED_AGENTS,
  MAX_RECOMMENDED_MODELS,
  MODEL_RECOMMENDATIONS_CLIENT_VERSION,
  MODEL_RECOMMENDATIONS_SCHEMA_VERSION,
  ModelRecommendationsEnvelopeSchema,
  ModelRecommendationsFileSchema,
  RECOMMENDATIONS_HARNESSES,
  selectRecommendationsSection,
} from "./model-recommendations.js";
export type {
  ModelRecommendationsCachePaths,
  ResolvedModelUpdates,
} from "./model-recommendations-cache.js";
export {
  DEFAULT_MODEL_UPDATES_CHANNEL,
  MODEL_RECOMMENDATIONS_CACHE_DIR,
  modelRecommendationsCachePaths,
  resolveModelUpdates,
} from "./model-recommendations-cache.js";
export { MODEL_RECOMMENDATIONS_PUBLIC_KEYS } from "./model-recommendations-keys.js";
export type {
  ModelRecommendationsFreshnessContext,
  ModelRecommendationsSignError,
  ModelRecommendationsVerifierDeps,
} from "./model-recommendations-verifier.js";
export {
  ModelRecommendationsVerifier,
  signModelRecommendations,
} from "./model-recommendations-verifier.js";
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
