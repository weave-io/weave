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
  NumberValue,
  Property,
  SettingAssignment,
  SourcePos,
  StepBlock,
  StringValue,
  WorkflowBlock,
} from "./ast.js";
export {
  boundConfigErrors,
  CONFIG_ERRORS_TRUNCATED,
  CONFIG_INPUT_LIMITS,
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
// End-to-end pipeline
// ---------------------------------------------------------------------------
export { parseConfig } from "./parse-config.js";
export { parse } from "./parser.js";
export type {
  SafeGraphCopyBudget,
  SafeGraphCopyError,
  SafeGraphValue,
} from "./safe-graph-copy.js";
export {
  copySafeGraph,
  DEFAULT_SAFE_GRAPH_COPY_BUDGET,
} from "./safe-graph-copy.js";
// ---------------------------------------------------------------------------
// Inferred config types
// ---------------------------------------------------------------------------
export type {
  AgentConfig,
  ArtifactDecl,
  CategoryConfig,
  CompletionMethod,
  DelegationTrigger,
  ExtendBeforePlan,
  ExtensionPoints,
  LogLevel,
  OnReject,
  ReconciliationHandler,
  ReconciliationReason,
  RoutingConfig,
  RuntimeSettings,
  SettingsConfig,
  ToolPermission,
  ToolPolicy,
  WeaveConfig,
  WorkflowConfig,
  WorkflowStep,
  WorkflowStepRole,
  WorkflowStepType,
} from "./schema.js";
// ---------------------------------------------------------------------------
// Schemas (Zod objects — useful for re-validation or extension)
// ---------------------------------------------------------------------------
export {
  AgentConfigSchema,
  ArtifactDeclSchema,
  CategoryConfigSchema,
  CompletionMethodSchema,
  DelegationTriggerSchema,
  ExtendBeforePlanSchema,
  ExtensionPointsSchema,
  LogLevelSchema,
  OnRejectSchema,
  ReconciliationHandlerListSchema,
  ReconciliationHandlerSchema,
  ReconciliationReasonSchema,
  RoutingConfigSchema,
  RuntimeSettingsSchema,
  SettingsConfigSchema,
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
// ---------------------------------------------------------------------------
// Trajectory events (Spec 33: harness trajectory evals)
// ---------------------------------------------------------------------------
export type {
  MessageEmittedEvent,
  RawArtifactRef,
  SessionCompletedEvent,
  SessionCreatedEvent,
  SessionErroredEvent,
  SubagentSpawnedEvent,
  ToolCallAfterEvent,
  ToolCallBeforeEvent,
  TrajectoryCase,
  TrajectoryEvent,
  TrajectoryEventParseError,
  TrajectoryResult,
  TrajectoryRunner,
  TrajectoryRunnerError,
  TrajectorySummary,
  TrajectoryWorkspace,
} from "./trajectory-events.js";
export {
  MessageEmittedEventSchema,
  RawArtifactRefSchema,
  SessionCompletedEventSchema,
  SessionCreatedEventSchema,
  SessionErroredEventSchema,
  SubagentSpawnedEventSchema,
  ToolCallAfterEventSchema,
  ToolCallBeforeEventSchema,
  TrajectoryEventSchema,
  TrajectoryResultSchema,
  TrajectorySummarySchema,
} from "./trajectory-events.js";
export { validate } from "./validate.js";
