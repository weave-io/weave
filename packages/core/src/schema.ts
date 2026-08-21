/**
 * Public schema barrel for validated Weave configuration.
 *
 * The implementations live in focused modules. Keep this file as the stable
 * import surface for consumers that historically imported `schema.ts` directly.
 */

export type {
  AgentConfig,
  AgentDelegationConfig,
  CategoryConfig,
  DelegationSettings,
  RoutingConfig,
  ToolPolicy,
} from "./schema-agent.js";
export {
  AgentConfigSchema,
  AgentDelegationConfigSchema,
  CategoryConfigSchema,
  DelegationSettingsSchema,
  RoutingConfigSchema,
  ToolPolicySchema,
} from "./schema-agent.js";
export type {
  ThinkingLevelDecl,
  ToolPermission,
} from "./schema-common.js";
export {
  DEFAULT_DELEGATION_LIMITS,
  MAX_DELEGATION_LIMITS,
  THINKING_LEVEL_VALUES,
  ThinkingLevelSchema,
  ToolPermissionSchema,
} from "./schema-common.js";
export type { WeaveConfig } from "./schema-config.js";
export { WeaveConfigSchema } from "./schema-config.js";
export type {
  JsonAdapterSettings,
  JsonValue,
  LogLevel,
  RuntimeJournalSettings,
  RuntimeLogSettings,
  RuntimeSettings,
  RuntimeUsageSettings,
  SettingsConfig,
} from "./schema-settings.js";
export {
  AdapterSettingsSchema,
  DEFAULT_RUNTIME_JOURNAL_SETTINGS,
  DEFAULT_RUNTIME_LOG_SETTINGS,
  DEFAULT_RUNTIME_SETTINGS,
  DEFAULT_RUNTIME_USAGE_SETTINGS,
  JsonValueSchema,
  LogLevelSchema,
  RuntimeJournalSettingsSchema,
  RuntimeLogSettingsSchema,
  RuntimeSettingsSchema,
  RuntimeUsageSettingsSchema,
  SettingsConfigSchema,
} from "./schema-settings.js";
export type {
  ArtifactDecl,
  CompletionMethod,
  ExtendBeforePlan,
  ExtensionPoints,
  OnReject,
  ReconciliationHandler,
  ReconciliationReason,
  WorkflowConfig,
  WorkflowStep,
  WorkflowStepRole,
  WorkflowStepType,
} from "./schema-workflow.js";
export {
  ArtifactDeclSchema,
  CompletionMethodSchema,
  ExtendBeforePlanSchema,
  ExtensionPointsSchema,
  OnRejectSchema,
  ReconciliationHandlerListSchema,
  ReconciliationHandlerSchema,
  ReconciliationReasonSchema,
  WorkflowConfigSchema,
  WorkflowStepRoleSchema,
  WorkflowStepSchema,
  WorkflowStepTypeSchema,
} from "./schema-workflow.js";
