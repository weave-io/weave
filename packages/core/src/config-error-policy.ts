import type { ConfigError } from "./errors.js";

export const MAX_CONFIG_ERROR_ISSUES = 32;
export const MAX_CONFIG_ERROR_PATH_LENGTH = 256;
export const MAX_CONFIG_ERROR_FIELD_LENGTH = 512;
export const MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE = 8 * 1024;
export const CONFIG_ERROR_COLLECTION_LIMIT = MAX_CONFIG_ERROR_ISSUES + 1;
export const CONFIG_ERRORS_TRUNCATED = "[config diagnostics truncated]";

/** Limits apply before the corresponding parser work begins. */
export const CONFIG_INPUT_LIMITS = {
  sourceLength: 1024 * 1024,
  tokens: 65_536,
  nesting: 64,
} as const;

/** Bound typed diagnostics; the last entry reports any truncation. */
export function boundConfigErrors<T extends ConfigError>(
  errors: readonly T[],
  marker: () => T,
): T[] {
  const output: T[] = [];
  let size = 0;
  let truncated = errors.length > MAX_CONFIG_ERROR_ISSUES;
  for (const error of errors.slice(0, MAX_CONFIG_ERROR_ISSUES)) {
    const fields = Object.entries(error).map(([key, value]) => {
      if (typeof value !== "string") return [key, value];
      const limit =
        key === "path"
          ? MAX_CONFIG_ERROR_PATH_LENGTH
          : MAX_CONFIG_ERROR_FIELD_LENGTH;
      if (value.length <= limit) return [key, value];
      truncated = true;
      return [key, `${value.slice(0, limit - 15)}... [truncated]`];
    });
    const bounded = Object.fromEntries(fields) as T;
    const nextSize = fields.reduce(
      (total, [, value]) =>
        total + (typeof value === "string" ? value.length : 0),
      0,
    );
    if (size + nextSize > MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE - 1024) {
      truncated = true;
      break;
    }
    size += nextSize;
    output.push(bounded);
  }
  if (!truncated) return output;
  if (output.length === MAX_CONFIG_ERROR_ISSUES) output.pop();
  output.push(marker());
  return output;
}
