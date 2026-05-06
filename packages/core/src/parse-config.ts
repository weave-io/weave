/**
 * End-to-end pipeline: raw `.weave` source → validated `WeaveConfig`.
 *
 * Chains: tokenize → parse → validate.
 * The first stage that fails short-circuits the pipeline and returns its errors.
 */

import { err, type Result } from "neverthrow";
import type { ConfigError } from "./errors.js";
import { tokenize } from "./lexer.js";
import { parse } from "./parser.js";
import { validate } from "./validate.js";
import type { WeaveConfig } from "./schema.js";

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
  if (lexResult.isErr()) return err(lexResult.error);

  const parseResult = parse(lexResult.value);
  if (parseResult.isErr()) return err(parseResult.error);

  const validateResult = validate(parseResult.value);
  if (validateResult.isErr()) return err(validateResult.error);

  return validateResult;
}
