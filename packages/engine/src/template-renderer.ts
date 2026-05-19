/**
 * template-renderer.ts
 *
 * Internal safe Mustache renderer wrapper for Weave prompt composition.
 *
 * Responsibilities:
 * - Preprocess escaped literal tags (\{{ and \{{{) before parsing/rendering
 * - Wrap Mustache.parse() to extract token metadata
 * - Reject unsupported token types (partials, delimiter changes)
 * - Validate referenced paths against an allowed-path set
 * - Reject unsafe paths (prototype traversal: __proto__, prototype, constructor)
 * - Reject function/callable values in the template context
 * - Render with default HTML escaping (double braces) and raw output (triple braces)
 * - Post-render unresolved-tag check
 * - Restore escaped literal tags after rendering
 *
 * This module has NO filesystem, environment, process, helper, lambda, or
 * partial-loading behavior. All functions return neverthrow Result types.
 *
 * NOT exported from packages/engine/src/index.ts (internal module).
 */

import Mustache from "mustache";
import { err, ok, type Result } from "neverthrow";

import { logger } from "./logger.js";

const log = logger.child({ module: "template-renderer" });

// ---------------------------------------------------------------------------
// Escaped literal placeholder constants
// ---------------------------------------------------------------------------

/** Placeholder used internally to protect escaped triple-brace tags during rendering. */
const ESCAPED_TRIPLE_PLACEHOLDER = "\x00WEAVE_ESCAPED_TRIPLE\x00";
/** Placeholder used internally to protect escaped double-brace tags during rendering. */
const ESCAPED_DOUBLE_PLACEHOLDER = "\x00WEAVE_ESCAPED_DOUBLE\x00";

// ---------------------------------------------------------------------------
// Unsafe path segments
// ---------------------------------------------------------------------------

const UNSAFE_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "toLocaleString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

// ---------------------------------------------------------------------------
// Mustache token types
// ---------------------------------------------------------------------------

/**
 * Mustache token types returned by Mustache.parse().
 * Reference: https://github.com/janl/mustache.js#pre-parsing-and-caching-templates
 */
type MustacheTokenType =
  | "name" // {{variable}}
  | "#" // {{#section}}
  | "^" // {{^inverted}}
  | "/" // {{/close}}
  | "&" // {{&unescaped}}
  | "{" // {{{triple-brace}}}
  | "!" // {{! comment}}
  | ">" // {{> partial}}
  | "=" // {{= delimiter change =}}
  | "text"; // raw text

/** A parsed Mustache token as returned by Mustache.parse(). */
type MustacheToken = [
  type: MustacheTokenType,
  value: string,
  startIndex: number,
  endIndex: number,
  children?: MustacheToken[],
  ...rest: unknown[],
];

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type RendererError =
  | {
      type: "MalformedTemplate";
      message: string;
      line?: number;
      column?: number;
    }
  | {
      type: "UnsupportedFeature";
      feature: "partial" | "delimiter-change";
      tag: string;
      message: string;
    }
  | {
      type: "UnknownPath";
      path: string;
      message: string;
    }
  | {
      type: "UnsafePath";
      path: string;
      message: string;
    }
  | {
      type: "FunctionValue";
      path: string;
      message: string;
    }
  | {
      type: "UnresolvedTag";
      tag: string;
      message: string;
    };

// ---------------------------------------------------------------------------
// Template context type
// ---------------------------------------------------------------------------

/**
 * A plain-object context for Mustache rendering.
 * No functions or callables are allowed anywhere in the tree.
 */
export interface TemplateContext {
  [key: string]: TemplateContextValue;
}

export type TemplateContextValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | TemplateContextValue[]
  | TemplateContext;

// ---------------------------------------------------------------------------
// Escaped literal preprocessing
// ---------------------------------------------------------------------------

/**
 * Preprocess template source to protect escaped literal tags.
 *
 * \{{{path}}} → ESCAPED_TRIPLE_PLACEHOLDER{path}}}
 * \{{path}}   → ESCAPED_DOUBLE_PLACEHOLDER{path}}
 *
 * The placeholders are restored after rendering.
 */
function preprocessEscapedLiterals(source: string): string {
  // Order matters: replace triple-brace escapes first to avoid double-matching
  let result = source.replace(/\\\{\{\{/g, ESCAPED_TRIPLE_PLACEHOLDER);
  result = result.replace(/\\\{\{/g, ESCAPED_DOUBLE_PLACEHOLDER);
  return result;
}

/**
 * Restore escaped literal placeholders back to their literal tag forms.
 *
 * ESCAPED_TRIPLE_PLACEHOLDER{path}}} → \{{{path}}}  (but without the backslash — literal output)
 * ESCAPED_DOUBLE_PLACEHOLDER{path}}  → \{{path}}}   (but without the backslash — literal output)
 *
 * The restored form is the literal tag text (without backslash), so the
 * user sees `{{path}}` as a literal string in the output.
 */
function restoreEscapedLiterals(rendered: string): string {
  let result = rendered.replace(
    new RegExp(escapeRegex(ESCAPED_TRIPLE_PLACEHOLDER), "g"),
    "{{{",
  );
  result = result.replace(
    new RegExp(escapeRegex(ESCAPED_DOUBLE_PLACEHOLDER), "g"),
    "{{",
  );
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Parse wrapper
// ---------------------------------------------------------------------------

/**
 * Parse a Mustache template source string into tokens.
 * Returns a typed Result — never throws for expected parse failures.
 */
function parseTemplate(source: string): Result<MustacheToken[], RendererError> {
  try {
    const tokens = Mustache.parse(source) as MustacheToken[];
    return ok(tokens);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log.debug({ cause }, "Mustache parse failed");
    return err({
      type: "MalformedTemplate",
      message: `Template parse error: ${message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

/**
 * Collect all token paths from a flat or nested token list.
 * Recursively descends into section children.
 */
function collectTokens(tokens: MustacheToken[]): MustacheToken[] {
  const result: MustacheToken[] = [];
  for (const token of tokens) {
    result.push(token);
    const children = token[4];
    if (Array.isArray(children) && children.length > 0) {
      result.push(...collectTokens(children as MustacheToken[]));
    }
  }
  return result;
}

/**
 * Validate all tokens in a parsed template recursively.
 *
 * Checks:
 * 1. No unsupported token types (partials, delimiter changes)
 * 2. No unsafe path segments
 * 3. All referenced paths are in the allowed set (or are "." for list items)
 *
 * Section-relative paths: child tokens within a section are relative to the
 * section's context object. When inside `{{#agent}}`, child paths like
 * `{{name}}` refer to `agent.name` — they are allowed because `agent` is
 * in the allowed set. We track whether we are inside a section to allow
 * child paths without requiring them to be in the top-level allowed set.
 *
 * @param tokens - tokens to validate (may be section children)
 * @param allowedPaths - top-level allowed paths
 * @param insideSection - true when validating children of a section token
 */
function validateTokens(
  tokens: MustacheToken[],
  allowedPaths: Set<string>,
  insideSection = false,
): Result<void, RendererError> {
  for (const token of tokens) {
    const [type, value] = token;

    // Reject partials
    if (type === ">") {
      return err({
        type: "UnsupportedFeature",
        feature: "partial",
        tag: `{{> ${value}}}`,
        message: `Partials are not supported: {{> ${value}}}`,
      });
    }

    // Reject delimiter changes
    if (type === "=") {
      return err({
        type: "UnsupportedFeature",
        feature: "delimiter-change",
        tag: `{{= ${value} =}}`,
        message: `Delimiter changes are not supported: {{= ${value} =}}`,
      });
    }

    // For sections and inverted sections: validate the section name itself,
    // then recursively validate children with insideSection=true
    if (type === "#" || type === "^") {
      if (!insideSection) {
        // Top-level section: validate against allowed paths
        const pathCheck = validatePath(value, allowedPaths);
        if (pathCheck.isErr()) return pathCheck;
      } else {
        // Nested section: only check for unsafe paths
        const unsafeCheck = checkUnsafePath(value);
        if (unsafeCheck.isErr()) return unsafeCheck;
      }

      // Recursively validate children — they are section-relative
      const children = token[4];
      if (Array.isArray(children) && children.length > 0) {
        const childResult = validateTokens(
          children as MustacheToken[],
          allowedPaths,
          true,
        );
        if (childResult.isErr()) return childResult;
      }
      continue;
    }

    // Skip close, text, comment tokens
    if (type === "text" || type === "!" || type === "/") {
      continue;
    }

    // For name, &, { tokens — validate the path
    if (type === "name" || type === "&" || type === "{") {
      // "." is the current-item reference — always allowed in list contexts
      if (value === ".") continue;

      if (insideSection) {
        // Inside a section: only check for unsafe paths
        // Child paths are relative to the section context object
        const unsafeCheck = checkUnsafePath(value);
        if (unsafeCheck.isErr()) return unsafeCheck;
      } else {
        // Top-level: validate against allowed paths
        const pathCheck = validatePath(value, allowedPaths);
        if (pathCheck.isErr()) return pathCheck;
      }
    }
  }

  return ok(undefined);
}

/**
 * Check a path for unsafe segments only (no allowed-path check).
 * Used for tokens inside sections where paths are context-relative.
 */
function checkUnsafePath(path: string): Result<void, RendererError> {
  const segments = path.split(".");
  for (const segment of segments) {
    if (UNSAFE_PATH_SEGMENTS.has(segment)) {
      return err({
        type: "UnsafePath",
        path,
        message: `Unsafe path segment "${segment}" in path "${path}" — prototype traversal is not allowed`,
      });
    }
  }
  return ok(undefined);
}

/**
 * Validate a single path reference.
 *
 * Rules:
 * - Reject any segment that is an unsafe prototype key
 * - Accept "." (current item)
 * - Accept if the full dotted path is in allowedPaths
 * - Accept if the root segment is in allowedPaths (section-relative access)
 * - Otherwise reject as UnknownPath
 */
function validatePath(
  path: string,
  allowedPaths: Set<string>,
): Result<void, RendererError> {
  const segments = path.split(".");

  // Check each segment for unsafe names
  for (const segment of segments) {
    if (UNSAFE_PATH_SEGMENTS.has(segment)) {
      return err({
        type: "UnsafePath",
        path,
        message: `Unsafe path segment "${segment}" in path "${path}" — prototype traversal is not allowed`,
      });
    }
  }

  // Full path allowed
  if (allowedPaths.has(path)) return ok(undefined);

  // Root segment allowed (section-relative access like agent.name when "agent" is allowed)
  const rootSegment = segments[0];
  if (rootSegment !== undefined && allowedPaths.has(rootSegment)) {
    return ok(undefined);
  }

  return err({
    type: "UnknownPath",
    path,
    message: `Template references unknown path "${path}" — not in allowed context`,
  });
}

// ---------------------------------------------------------------------------
// Function/callable value rejection
// ---------------------------------------------------------------------------

/**
 * Recursively scan a context value for any function or callable.
 * Returns an error if any callable is found.
 */
function rejectFunctionValues(
  value: unknown,
  path: string,
): Result<void, RendererError> {
  if (typeof value === "function") {
    return err({
      type: "FunctionValue",
      path,
      message: `Function value at path "${path}" is not allowed — Mustache lambdas are disabled`,
    });
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const check = rejectFunctionValues(value[i], `${path}[${i}]`);
      if (check.isErr()) return check;
    }
    return ok(undefined);
  }

  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const check = rejectFunctionValues(
        val,
        path === "" ? key : `${path}.${key}`,
      );
      if (check.isErr()) return check;
    }
  }

  return ok(undefined);
}

/**
 * Validate that no function or callable values exist anywhere in the context.
 */
function validateNoFunctionValues(
  context: TemplateContext,
): Result<void, RendererError> {
  return rejectFunctionValues(context, "");
}

// ---------------------------------------------------------------------------
// Post-render unresolved-tag check
// ---------------------------------------------------------------------------

/**
 * After rendering, scan for any remaining unresolved Mustache tags.
 *
 * Allows:
 * - Restored escaped literals (which produce literal `{{` or `{{{` text)
 *
 * Rejects:
 * - Any remaining `{{...}}` or `{{{...}}}` that were not resolved
 *
 * Strategy: after restoreEscapedLiterals(), the output may contain literal
 * `{{` sequences that came from escaped inputs. We need to distinguish those
 * from real unresolved tags.
 *
 * We do this by checking the rendered output BEFORE restoration for any
 * remaining `{{` patterns (excluding our placeholders).
 */
function checkUnresolvedTags(
  renderedBeforeRestore: string,
): Result<void, RendererError> {
  // After Mustache renders, any remaining {{ or {{{ are unresolved tags.
  // Our placeholders don't contain {{ so they won't match.
  const unresolvedMatch = renderedBeforeRestore.match(/\{\{[^}]*\}\}/);
  if (unresolvedMatch !== null) {
    const tag = unresolvedMatch[0];
    return err({
      type: "UnresolvedTag",
      tag,
      message: `Unresolved template tag "${tag}" after rendering — check that all referenced paths have values`,
    });
  }

  // Also check for triple-brace unresolved
  const unresolvedTriple = renderedBeforeRestore.match(/\{\{\{[^}]*\}\}\}/);
  if (unresolvedTriple !== null) {
    const tag = unresolvedTriple[0];
    return err({
      type: "UnresolvedTag",
      tag,
      message: `Unresolved template tag "${tag}" after rendering — check that all referenced paths have values`,
    });
  }

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /**
   * Set of allowed top-level and dotted paths in the template context.
   * Paths not in this set (or whose root segment is not in this set) are rejected.
   */
  allowedPaths: Set<string>;
}

/**
 * Safely render a Mustache template string with the given context.
 *
 * Steps:
 * 1. Preprocess escaped literal tags (\{{ and \{{{)
 * 2. Parse the template
 * 3. Validate tokens (unsupported features, unsafe paths, unknown paths)
 * 4. Validate no function/callable values in context
 * 5. Render with Mustache (HTML escaping for {{...}}, raw for {{{...}}})
 * 6. Check for unresolved tags in rendered output (before restoration)
 * 7. Restore escaped literal placeholders
 *
 * Returns Result<string, RendererError> — never throws for expected failures.
 */
export function renderTemplate(
  source: string,
  context: TemplateContext,
  options: RenderOptions,
): Result<string, RendererError> {
  log.debug({ sourceLength: source.length }, "Rendering template");

  // Step 1: Preprocess escaped literals
  const preprocessed = preprocessEscapedLiterals(source);

  // Step 2: Parse
  const parseResult = parseTemplate(preprocessed);
  if (parseResult.isErr()) return err(parseResult.error);
  const tokens = parseResult.value;

  // Step 3: Validate tokens
  const tokenValidation = validateTokens(tokens, options.allowedPaths);
  if (tokenValidation.isErr()) return err(tokenValidation.error);

  // Step 4: Validate no function values in context
  const funcValidation = validateNoFunctionValues(context);
  if (funcValidation.isErr()) return err(funcValidation.error);

  // Step 5: Render
  let rendered: string;
  try {
    rendered = Mustache.render(preprocessed, context);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log.debug({ cause }, "Mustache render failed");
    return err({
      type: "MalformedTemplate",
      message: `Template render error: ${message}`,
    });
  }

  // Step 6: Check for unresolved tags (before restoration)
  const unresolvedCheck = checkUnresolvedTags(rendered);
  if (unresolvedCheck.isErr()) return err(unresolvedCheck.error);

  // Step 7: Restore escaped literals
  const final = restoreEscapedLiterals(rendered);

  log.debug({ outputLength: final.length }, "Template rendered successfully");
  return ok(final);
}

// ---------------------------------------------------------------------------
// Utility: extract all referenced paths from a template
// ---------------------------------------------------------------------------

/**
 * Extract all variable/section paths referenced in a template source.
 * Useful for pre-validation or documentation.
 *
 * Returns a Result to handle parse failures gracefully.
 */
export function extractTemplatePaths(
  source: string,
): Result<string[], RendererError> {
  const preprocessed = preprocessEscapedLiterals(source);
  const parseResult = parseTemplate(preprocessed);
  if (parseResult.isErr()) return err(parseResult.error);

  const allTokens = collectTokens(parseResult.value);
  const paths = new Set<string>();

  for (const token of allTokens) {
    const [type, value] = token;
    if (
      type === "name" ||
      type === "&" ||
      type === "{" ||
      type === "#" ||
      type === "^"
    ) {
      if (value !== ".") {
        paths.add(value);
      }
    }
  }

  return ok(Array.from(paths));
}
