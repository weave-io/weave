/**
 * Public API for @weave/core.
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
  IdentifierValue,
  NumberValue,
  Property,
  SettingAssignment,
  SourcePos,
  StepBlock,
  StringValue,
  WorkflowBlock,
} from "./ast.js";
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
// ---------------------------------------------------------------------------
// Inferred config types
// ---------------------------------------------------------------------------
export type {
  AgentConfig,
  ArtifactRef,
  CategoryConfig,
  CompletionMethod,
  DelegationTrigger,
  OnReject,
  ToolPermission,
  WeaveConfig,
  WorkflowConfig,
  WorkflowStep,
  WorkflowStepType,
} from "./schema.js";
// ---------------------------------------------------------------------------
// Schemas (Zod objects — useful for re-validation or extension)
// ---------------------------------------------------------------------------
export {
  AgentConfigSchema,
  ArtifactRefSchema,
  CategoryConfigSchema,
  CompletionMethodSchema,
  DelegationTriggerSchema,
  OnRejectSchema,
  ToolPermissionSchema,
  WeaveConfigSchema,
  WorkflowConfigSchema,
  WorkflowStepSchema,
  WorkflowStepTypeSchema,
} from "./schema.js";
// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------
export type { Token } from "./tokens.js";
export { TokenType } from "./tokens.js";
export { validate } from "./validate.js";
