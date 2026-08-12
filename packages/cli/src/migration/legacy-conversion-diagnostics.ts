/**
 * Bounded, sanitized conversion diagnostics.
 *
 * Warning field paths use stable vocabulary keys, numeric indices, or the
 * `<entry>` placeholder. Reasons use a fixed vocabulary plus a primitive type
 * category. Source values, prompt paths, names, modes, and malformed scalars
 * are never interpolated.
 */

import {
  isDangerousDslName,
  isDslIdentifierShape,
} from "./legacy-dsl-identifiers.js";
import type { ConversionWarning } from "./types.js";

export const MAX_CONVERSION_WARNINGS = 32;
export const MAX_WARNING_FIELD_LENGTH = 256;
export const MAX_WARNING_REASON_LENGTH = 512;
export const MAX_WARNING_DIAGNOSTIC_SIZE = 8 * 1024;
export const WARNING_TRUNCATION_SUFFIX = "... [truncated]";
export const WARNINGS_TRUNCATED_REASON =
  "additional conversion diagnostics were truncated";

export const PATH_SOURCE = "<source>";
export const PATH_DSL = "<dsl>";
export const PATH_ENTRY = "<entry>";
export const PATH_DIAGNOSTICS = "<diagnostics>";

export const CONVERSION_REASON = {
  parseFailed:
    "failed to parse legacy JSONC source; no fields could be converted",
  sourceTooLarge: "legacy JSONC source exceeds conversion size bounds",
  duplicateKey: "duplicate object key; skipped to avoid silent collapse",
  dangerousKey: "dangerous object key is not allowed",
  invalidIdentifier: "name is not a valid DSL identifier; skipped",
  dangerousName: "dangerous name is not allowed; skipped",
  expectedArray: "expected an array; skipped",
  expectedObject: "expected an object; skipped",
  expectedString: "expected a string; skipped",
  expectedBoolean: "expected a boolean; skipped",
  expectedArrayAgentNames: "expected an array of agent names; skipped",
  expectedArrayHookNames: "expected an array of hook names; skipped",
  expectedArraySkillNames: "expected an array of skill names; skipped",
  expectedStringLogLevel: "expected a string log level value; skipped",
  expectedStringModel: "expected a string model name; skipped",
  expectedArrayModels: "expected an array of model names; skipped",
  expectedStringPath: "expected a string path; skipped",
  expectedTriggerArray:
    "expected an array of trigger strings or legacy trigger objects; skipped",
  expectedAgentObject: "expected an object of agent override entries; skipped",
  expectedCustomAgentObject:
    "expected an object of custom agent entries; skipped",
  expectedCategoryObject: "expected an object of category entries; skipped",
  expectedObjectEntry: "expected an object; skipped",
  invalidLogLevel:
    "value is not a valid log level (expected one of TRACE, DEBUG, INFO, WARN, ERROR, FATAL); skipped",
  invalidMode:
    "value is not a valid mode (expected primary, subagent, or all); skipped",
  invalidTemperature:
    "numeric value is not a finite temperature in range 0 to 2; skipped",
  invalidModel:
    "model entry is not a valid current-schema model string; skipped",
  emptyString: "empty string discarded",
  emptyTrigger: "empty trigger string discarded",
  malformedEntry: "malformed entry discarded",
  malformedTrigger: "malformed trigger entry discarded",
  discardedStructuredField:
    "legacy structured field cannot be represented as a trigger string; discarded",
  unsupportedField: "field is not supported in migration v1; skipped",
  unknownField: "unknown legacy field; not supported in migration v1",
  patternsDropped:
    "category file patterns are not supported; dropped valid patterns and did not emit a replacement",
  patternsMalformed:
    "malformed category patterns discarded; categories no longer use file patterns",
  patternsEmpty:
    "empty category patterns discarded; categories no longer use file patterns",
  patternMalformed: "malformed category pattern discarded",
  descriptionRequired: "a non-empty string is required; category skipped",
  notBuiltin:
    'name is not a builtin agent name; entries under "agents" are overrides of existing builtins only — use "custom_agents" to create new agents',
  builtinCollision:
    "name collides with a builtin agent name; skipped to avoid silently overriding the builtin",
  promptFileUnsafe:
    "prompt_file contains directory components and cannot be safely translated; skipped",
  promptFileSkipped:
    "both prompt and prompt_file are set; prompt_file skipped (prompt takes precedence)",
  toolAmbiguous:
    "tool name is harness-specific and cannot be mapped to an abstract tool_policy capability; skipped",
  toolUnknown:
    "unknown legacy tool name that cannot be mapped to an abstract tool_policy capability; skipped",
  toolNotBoolean: "tool permission must be a boolean; skipped",
  fastAlias: "field is not converted to fast intent; skipped",
  omittedInvalid:
    "converted DSL did not validate against the current schema; omitted",
  truncated: WARNINGS_TRUNCATED_REASON,
} as const;

const TYPE_CATEGORIES = new Set([
  "null",
  "array",
  "object",
  "string",
  "empty_string",
  "number",
  "non_finite_number",
  "boolean",
  "undefined",
  "function",
  "bigint",
  "symbol",
  "other",
]);

export type PrimitiveTypeCategory =
  | "null"
  | "array"
  | "object"
  | "string"
  | "empty_string"
  | "number"
  | "non_finite_number"
  | "boolean"
  | "undefined"
  | "function"
  | "bigint"
  | "symbol"
  | "other";

/** Classify a value as a fixed primitive type category. Never returns source text. */
export function primitiveCategory(value: unknown): PrimitiveTypeCategory {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isFinite(value) ? "number" : "non_finite_number";
  }
  if (typeof value === "string") {
    return value.trim().length === 0 ? "empty_string" : "string";
  }
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "function") return "function";
  if (typeof value === "bigint") return "bigint";
  if (typeof value === "symbol") return "symbol";
  if (typeof value === "object") return "object";
  return "other";
}

/** Append a fixed type category to a vocabulary reason. */
export function reasonWithType(reason: string, value: unknown): string {
  const category = primitiveCategory(value);
  if (!TYPE_CATEGORIES.has(category)) return reason;
  return `${reason} (type: ${category})`;
}

function pathSegment(key: string): string {
  if (key.startsWith("<") && key.endsWith(">")) return key;
  if (isDangerousDslName(key) || !isDslIdentifierShape(key)) return PATH_ENTRY;
  return key;
}

/**
 * Build a bounded diagnostic path from vocabulary keys, indices, and sanitized
 * source keys. Invalid or dangerous keys become `<entry>`.
 */
export function joinPath(parts: Array<string | number>): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (part === "") continue;
    if (typeof part === "number") {
      if (!Number.isSafeInteger(part) || part < 0) {
        segments.push(PATH_ENTRY);
        continue;
      }
      segments.push(String(part));
      continue;
    }
    segments.push(pathSegment(part));
  }
  return segments.join(".");
}

function truncateWarningText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - WARNING_TRUNCATION_SUFFIX.length)}${WARNING_TRUNCATION_SUFFIX}`;
}

function warningSize(warning: ConversionWarning): number {
  return warning.field.length + warning.reason.length;
}

/** Bound a single warning's path and reason lengths. */
export function boundWarning(warning: ConversionWarning): ConversionWarning {
  return {
    field: truncateWarningText(warning.field, MAX_WARNING_FIELD_LENGTH),
    reason: truncateWarningText(warning.reason, MAX_WARNING_REASON_LENGTH),
  };
}

/**
 * Push a sanitized warning, enforcing count, per-field, and aggregate byte
 * bounds with a deterministic truncation marker.
 */
export function pushWarning(
  warnings: ConversionWarning[],
  field: string,
  reason: string,
): void {
  const next = boundWarning({ field, reason });
  let aggregate = 0;
  for (const warning of warnings) {
    aggregate += warningSize(warning);
  }
  const wouldExceedCount = warnings.length >= MAX_CONVERSION_WARNINGS;
  const wouldExceedSize =
    aggregate + warningSize(next) > MAX_WARNING_DIAGNOSTIC_SIZE;
  if (wouldExceedCount || wouldExceedSize) {
    const marker = boundWarning({
      field: PATH_DIAGNOSTICS,
      reason: WARNINGS_TRUNCATED_REASON,
    });
    const last = warnings[warnings.length - 1];
    if (last?.field === marker.field && last.reason === marker.reason) {
      return;
    }
    if (warnings.length >= MAX_CONVERSION_WARNINGS) {
      warnings[warnings.length - 1] = marker;
      return;
    }
    warnings.push(marker);
    return;
  }
  warnings.push(next);
}

/** Absorb extra warnings through the same bound/sanitize seam. */
export function absorbWarnings(
  warnings: ConversionWarning[],
  extra: ConversionWarning[],
): void {
  for (const warning of extra) {
    pushWarning(warnings, warning.field, warning.reason);
  }
}
