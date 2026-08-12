/**
 * End-to-end pipeline: raw `.weave` source → validated `WeaveConfig`.
 *
 * Chains: tokenize → parse → validate.
 * The first stage that fails short-circuits the pipeline and returns its errors.
 */

import { err, type Result } from "neverthrow";
import {
  boundConfigErrors,
  CONFIG_ERRORS_TRUNCATED,
} from "./config-error-policy.js";
import type {
  ConfigError,
  LexError,
  ParseError,
  ValidationError,
} from "./errors.js";
import { tokenize } from "./lexer.js";
import { parse } from "./parser.js";
import type { WeaveConfig } from "./schema.js";
import { validate } from "./validate.js";

/**
 * Parse and validate a `.weave` source string.
 *
 * - If lexing fails → returns `LexError[]`
 * - If parsing fails → returns `ParseError[]`
 * - If validation fails → returns `ValidationError[]`
 * - On success → returns `WeaveConfig`
 */
export function parseConfig(
  source: string,
): Result<WeaveConfig, ConfigError[]> {
  const lexResult = tokenize(source);
  if (lexResult.isErr()) {
    return err(
      boundConfigErrors<LexError>(lexResult.error, () => ({
        type: "UnexpectedCharacter",
        line: 0,
        column: 0,
        char: CONFIG_ERRORS_TRUNCATED,
      })),
    );
  }

  const parseResult = parse(lexResult.value);
  if (parseResult.isErr()) {
    return err(
      boundConfigErrors<ParseError>(parseResult.error, () => ({
        type: "UnexpectedToken",
        line: 0,
        column: 0,
        found: "",
        expected: CONFIG_ERRORS_TRUNCATED,
      })),
    );
  }

  const validateResult = validate(parseResult.value);
  if (validateResult.isErr()) {
    return err(
      boundConfigErrors<ValidationError>(validateResult.error, () => ({
        type: "ValidationError",
        path: "",
        message: CONFIG_ERRORS_TRUNCATED,
      })),
    );
  }

  return validateResult;
}
