import type { ConfigError } from "./errors.js";

/** Maximum number of diagnostics returned by any core config boundary. */
export const MAX_CONFIG_ERROR_ISSUES = 32;
/** Maximum length of a diagnostic path. */
export const MAX_CONFIG_ERROR_PATH_LENGTH = 256;
/** Maximum length of every other string field in a diagnostic. */
export const MAX_CONFIG_ERROR_FIELD_LENGTH = 512;
/** Maximum aggregate length of all diagnostic string fields. */
export const MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE = 8 * 1024;
export const CONFIG_ERRORS_TRUNCATED = "[config diagnostics truncated]";

const COLLECTION_LIMIT = MAX_CONFIG_ERROR_ISSUES + 1;
const TRUNCATION_SUFFIX = "... [truncated]";

export const CONFIG_ERROR_COLLECTION_LIMIT = COLLECTION_LIMIT;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function boundStringFields(error: ConfigError): ConfigError {
  switch (error.type) {
    case "InvalidNumber":
      return {
        ...error,
        value: truncate(error.value, MAX_CONFIG_ERROR_FIELD_LENGTH),
      };
    case "UnexpectedCharacter":
      return {
        ...error,
        char: truncate(error.char, MAX_CONFIG_ERROR_FIELD_LENGTH),
      };
    case "UnexpectedToken":
      return {
        ...error,
        found: truncate(error.found, MAX_CONFIG_ERROR_FIELD_LENGTH),
        expected: truncate(error.expected, MAX_CONFIG_ERROR_FIELD_LENGTH),
      };
    case "MissingBlockName":
      return {
        ...error,
        blockType: truncate(error.blockType, MAX_CONFIG_ERROR_FIELD_LENGTH),
      };
    case "ValidationError":
      return {
        ...error,
        path: truncate(error.path, MAX_CONFIG_ERROR_PATH_LENGTH),
        message: truncate(error.message, MAX_CONFIG_ERROR_FIELD_LENGTH),
      };
    case "UnterminatedString":
    case "UnclosedBlock":
      return error;
  }
}

function stringSize(error: ConfigError): number {
  switch (error.type) {
    case "InvalidNumber":
      return error.value.length;
    case "UnexpectedCharacter":
      return error.char.length;
    case "UnexpectedToken":
      return error.found.length + error.expected.length;
    case "MissingBlockName":
      return error.blockType.length;
    case "ValidationError":
      return error.path.length + error.message.length;
    case "UnterminatedString":
    case "UnclosedBlock":
      return 0;
  }
}

/**
 * Apply one deterministic fail-closed policy to lexer, parser, and validation
 * diagnostics. The final marker reports any field, count, or aggregate
 * truncation without exposing more source-controlled text.
 */
export function boundConfigErrors<T extends ConfigError>(
  errors: readonly T[],
  truncationMarker: () => T,
): T[];
export function boundConfigErrors(
  errors: readonly ConfigError[],
  truncationMarker: () => ConfigError,
): ConfigError[] {
  let fieldWasTruncated = false;
  const sanitized = errors.map((error) => {
    const bounded = boundStringFields(error);
    fieldWasTruncated ||= stringSize(bounded) !== stringSize(error);
    return bounded;
  });
  const aggregateSize = sanitized.reduce(
    (size, error) => size + stringSize(error),
    0,
  );
  if (
    !fieldWasTruncated &&
    sanitized.length <= MAX_CONFIG_ERROR_ISSUES &&
    aggregateSize <= MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE
  ) {
    return sanitized;
  }

  const bounded: ConfigError[] = [];
  let size = 0;
  for (const error of sanitized) {
    if (bounded.length >= MAX_CONFIG_ERROR_ISSUES - 1) break;
    const nextSize = stringSize(error);
    if (
      size + nextSize + CONFIG_ERRORS_TRUNCATED.length >
      MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE
    ) {
      break;
    }
    bounded.push(error);
    size += nextSize;
  }
  bounded.push(truncationMarker());
  return bounded;
}
