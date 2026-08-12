/**
 * DSL identifier contract for legacy conversion.
 *
 * Converted agent and category names are emitted as bare identifiers.
 * Names that would not tokenize as identifiers, exceed the length bound,
 * or match the dangerous-name set must be rejected before emission.
 */

export const DANGEROUS_DSL_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Maximum identifier length accepted for converted agent/category names. */
export const MAX_DSL_IDENTIFIER_LENGTH = 128;

const DSL_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

export type DslNameClassification = "ok" | "dangerous" | "invalid";

/** True when `name` is a prototype-pollution or reserved dangerous identifier. */
export function isDangerousDslName(name: string): boolean {
  return DANGEROUS_DSL_NAMES.has(name);
}

/** True when `name` matches the current lexer identifier grammar and length bound. */
export function isDslIdentifierShape(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_DSL_IDENTIFIER_LENGTH &&
    DSL_IDENTIFIER_RE.test(name)
  );
}

/**
 * Classify a candidate agent/category name before DSL emission.
 *
 * Dangerous names are reported separately from other invalid identifiers so
 * warnings can use a fixed reason without echoing the source key.
 */
export function classifyDslName(name: string): DslNameClassification {
  if (isDangerousDslName(name)) return "dangerous";
  if (!isDslIdentifierShape(name)) return "invalid";
  return "ok";
}

/** True when `name` is safe to emit as a bare DSL identifier. */
export function isEmittableDslName(name: string): boolean {
  return classifyDslName(name) === "ok";
}
