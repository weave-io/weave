/**
 * Public API for @weaveio/weave-core.
 *
 * All consumers should import from this barrel — never from internal modules
 * directly. This keeps the internal structure refactorable without breaking
 * downstream packages.
 */

// ---------------------------------------------------------------------------
// AST types
// ---------------------------------------------------------------------------
export type {
  AgentBlock,
  ArrayValue,
  AstNode,
  AstValue,
  BlockValue,
  BooleanValue,
  CategoryBlock,
  DisableDirective,
  ExtendBeforePlanDirective,
  IdentifierValue,
  NullValue,
  NumberValue,
  Property,
  SettingAssignment,
  SourcePos,
  StepBlock,
  StringValue,
  WorkflowBlock,
} from "./ast.js";
// ---------------------------------------------------------------------------
// End-to-end pipeline
// ---------------------------------------------------------------------------
export {
  CONFIG_ERRORS_TRUNCATED,
  MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE,
  MAX_CONFIG_ERROR_FIELD_LENGTH,
  MAX_CONFIG_ERROR_ISSUES,
  MAX_CONFIG_ERROR_PATH_LENGTH,
} from "./config-error-policy.js";
// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------
export type {
  ConfigError,
  LexError,
  ParseError,
  ValidationError,
} from "./errors.js";
export { formatError } from "./errors.js";
// ---------------------------------------------------------------------------
// Pipeline stages (exported for advanced / test use)
// ---------------------------------------------------------------------------
export { tokenize } from "./lexer.js";
// ---------------------------------------------------------------------------
// Model thinking syntax
// ---------------------------------------------------------------------------
export type {
  ModelIntentEntry,
  ModelIntentParseError,
} from "./model-thinking-syntax.js";
export { parseModelIntentEntry } from "./model-thinking-syntax.js";
export { parseConfig } from "./parse-config.js";
export { parse } from "./parser.js";
export type {
  SafeGraphCopyBudget,
  SafeGraphCopyError,
  SafeGraphObject,
  SafeGraphPrimitive,
  SafeGraphValue,
} from "./safe-graph-copy.js";
export { copySafeGraph } from "./safe-graph-copy.js";
// ---------------------------------------------------------------------------
// Inferred config types
// ---------------------------------------------------------------------------
export type {
  AgentConfig,
  AgentDelegationConfig,
  ArtifactDecl,
  CategoryConfig,
  CompletionMethod,
  DelegationSettings,
  ExtendBeforePlan,
  ExtensionPoints,
  JsonValue,
  LogLevel,
  OnReject,
  ReconciliationHandler,
  ReconciliationReason,
  RoutingConfig,
  RuntimeJournalSettings,
  RuntimeLogSettings,
  RuntimeSettings,
  RuntimeUsageSettings,
  SettingsConfig,
  ThinkingLevelDecl,
  ToolPermission,
  ToolPolicy,
  WeaveConfig,
  WorkflowConfig,
  WorkflowStep,
  WorkflowStepRole,
  WorkflowStepType,
} from "./schema.js";
// ---------------------------------------------------------------------------
// Schemas (bounded Zod schemas — useful for re-validation or extension)
// Object, array, and recursive schemas snapshot hostile input before validation.
// ---------------------------------------------------------------------------
export {
  AdapterSettingsSchema,
  AgentConfigSchema,
  AgentDelegationConfigSchema,
  ArtifactDeclSchema,
  CategoryConfigSchema,
  CompletionMethodSchema,
  DEFAULT_DELEGATION_LIMITS,
  DEFAULT_RUNTIME_JOURNAL_SETTINGS,
  DEFAULT_RUNTIME_LOG_SETTINGS,
  DEFAULT_RUNTIME_SETTINGS,
  DEFAULT_RUNTIME_USAGE_SETTINGS,
  DelegationSettingsSchema,
  ExtendBeforePlanSchema,
  ExtensionPointsSchema,
  JsonValueSchema,
  LogLevelSchema,
  MAX_DELEGATION_LIMITS,
  OnRejectSchema,
  ReconciliationHandlerListSchema,
  ReconciliationHandlerSchema,
  ReconciliationReasonSchema,
  RoutingConfigSchema,
  RuntimeJournalSettingsSchema,
  RuntimeLogSettingsSchema,
  RuntimeSettingsSchema,
  RuntimeUsageSettingsSchema,
  SettingsConfigSchema,
  THINKING_LEVEL_VALUES,
  ThinkingLevelSchema,
  ToolPermissionSchema,
  ToolPolicySchema,
  WeaveConfigSchema,
  WorkflowConfigSchema,
  WorkflowStepRoleSchema,
  WorkflowStepSchema,
  WorkflowStepTypeSchema,
} from "./schema.js";
// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------
export type { Token } from "./tokens.js";
export { TokenType } from "./tokens.js";
export { validate } from "./validate.js";
