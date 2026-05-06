/**
 * Validates an `AstNode[]` produced by the parser against the Zod schemas,
 * returning a fully-typed `WeaveConfig` or an array of `ValidationError`s.
 */

import { err, ok, type Result } from "neverthrow";
import type { ZodError } from "zod";
import type { AstNode, AstValue, Property } from "./ast.js";
import type { ValidationError } from "./errors.js";
import { type WeaveConfig, WeaveConfigSchema } from "./schema.js";

// ---------------------------------------------------------------------------
// AST → plain object helpers
// ---------------------------------------------------------------------------

/**
 * Convert an `AstValue` into a plain JS value suitable for Zod parsing.
 */
function astValueToPlain(value: AstValue): unknown {
  switch (value.kind) {
    case "string":
      return value.value;
    case "number":
      return value.value;
    case "boolean":
      return value.value;
    case "identifier":
      return value.value;
    case "array":
      return value.elements.map(astValueToPlain);
    case "block":
      return propertiesToObject(value.properties);
  }
}

/**
 * Convert a `Property[]` array into a plain key-value object.
 */
function propertiesToObject(props: Property[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const prop of props) {
    obj[prop.key] = astValueToPlain(prop.value);
  }
  return obj;
}

/**
 * Walk `AstNode[]` and build a plain object shaped for `WeaveConfigSchema`.
 */
function astToPlainObject(nodes: AstNode[]): Record<string, unknown> {
  const agents: Record<string, unknown> = {};
  const categories: Record<string, unknown> = {};
  const disabled: Record<string, string[]> = {};
  const workflows: Record<string, unknown> = {};
  const settings: Record<string, unknown> = {};

  for (const node of nodes) {
    switch (node.type) {
      case "agent":
        agents[node.name] = propertiesToObject(node.properties);
        break;

      case "category":
        categories[node.name] = propertiesToObject(node.properties);
        break;

      case "workflow":
        workflows[node.name] = {
          ...propertiesToObject(node.properties),
          steps: node.steps.map((s) => ({
            name: s.name,
            ...propertiesToObject(s.properties),
          })),
        };
        break;

      case "disable":
        disabled[node.target] = [
          ...(disabled[node.target] ?? []),
          ...node.items,
        ];
        break;

      case "setting":
        settings[node.key] = astValueToPlain(node.value);
        break;
    }
  }

  const result: Record<string, unknown> = { ...settings };
  if (Object.keys(agents).length > 0) result.agents = agents;
  if (Object.keys(categories).length > 0) result.categories = categories;
  if (Object.keys(disabled).length > 0) result.disabled = disabled;
  if (Object.keys(workflows).length > 0) result.workflows = workflows;

  return result;
}

// ---------------------------------------------------------------------------
// Zod error → ValidationError mapping
// ---------------------------------------------------------------------------

function zodErrorToValidationErrors(zodError: ZodError): ValidationError[] {
  return zodError.issues.map((issue) => ({
    type: "ValidationError" as const,
    path: issue.path.join("."),
    message: issue.message,
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates an `AstNode[]` against the `WeaveConfigSchema`.
 * Returns a fully-typed `WeaveConfig` or an array of `ValidationError`s.
 */
export function validate(
  ast: AstNode[],
): Result<WeaveConfig, ValidationError[]> {
  const plain = astToPlainObject(ast);
  const parsed = WeaveConfigSchema.safeParse(plain);

  if (!parsed.success) {
    return err(zodErrorToValidationErrors(parsed.error));
  }

  return ok(parsed.data);
}
