/**
 * Public API for @weave/core.
 *
 * All consumers should import from this barrel — never from internal modules
 * directly. This keeps the internal structure refactorable without breaking
 * downstream packages.
 */

// ---------------------------------------------------------------------------
// End-to-end pipeline
// ---------------------------------------------------------------------------
export { parseConfig } from "./parse-config.js";

// ---------------------------------------------------------------------------
// Pipeline stages (exported for advanced / test use)
// ---------------------------------------------------------------------------
export { tokenize } from "./lexer.js";
export { parse } from "./parser.js";
export { validate } from "./validate.js";

// ---------------------------------------------------------------------------
// Schemas (Zod objects — useful for re-validation or extension)
// ---------------------------------------------------------------------------
export {
  AgentConfigSchema,
  CategoryConfigSchema,
  WeaveConfigSchema,
  ToolPermissionSchema,
  DelegationTriggerSchema,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Inferred config types
// ---------------------------------------------------------------------------
export type {
  AgentConfig,
  CategoryConfig,
  WeaveConfig,
  ToolPermission,
  DelegationTrigger,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------
export type {
  LexError,
  ParseError,
  ValidationError,
  ConfigError,
} from "./errors.js";
export { formatError } from "./errors.js";

// ---------------------------------------------------------------------------
// AST types
// ---------------------------------------------------------------------------
export type {
  AstNode,
  AstValue,
  Property,
  StepBlock,
  SourcePos,
  AgentBlock,
  CategoryBlock,
  WorkflowBlock,
  DisableDirective,
  SettingAssignment,
  StringValue,
  NumberValue,
  BooleanValue,
  IdentifierValue,
  ArrayValue,
  BlockValue,
} from "./ast.js";

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------
export type { Token } from "./tokens.js";
export { TokenType } from "./tokens.js";
