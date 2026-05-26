/**
 * Validates an `AstNode[]` produced by the parser against the Zod schemas,
 * returning a fully-typed `WeaveConfig` or an array of `ValidationError`s.
 */

import { err, ok, type Result } from "neverthrow";
import type { ZodError } from "zod";
import type {
  AstNode,
  AstValue,
  BlockValue,
  IdentifierValue,
  Property,
} from "./ast.js";
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
 * Transform a step's properties into a plain object shaped for `WorkflowStepSchema`.
 *
 * Mapping rules:
 * - The step's block name (e.g. `step plan { }` → `"plan"`) maps to `name`.
 * - The inner `name "..."` property maps to `display_name` to avoid collision.
 * - A bare `completion user_confirm` (IdentifierValue) maps to `{ method: "user_confirm" }`.
 * - A named block `completion plan_created { plan_name "x" }` (BlockValue with `__name`)
 *   maps to `{ method: "plan_created", plan_name: "x" }`.
 * - All other properties are converted with `astValueToPlain`.
 */
function transformStepProperties(
  stepName: string,
  properties: Property[],
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  obj.name = stepName;

  for (const prop of properties) {
    if (prop.key === "name") {
      obj.display_name = astValueToPlain(prop.value);
      continue;
    }

    if (prop.key === "completion") {
      if (prop.value.kind === "identifier") {
        const iv = prop.value as IdentifierValue;
        obj.completion = { method: iv.value };
      } else if (prop.value.kind === "block") {
        const bv = prop.value as BlockValue;
        const blockObj = propertiesToObject(bv.properties);
        const { __name: methodRaw, ...params } = blockObj;
        obj.completion = { method: methodRaw as string, ...params };
      }
      continue;
    }

    obj[prop.key] = astValueToPlain(prop.value);
  }

  return obj;
}

/**
 * Walk `AstNode[]` and build a plain object shaped for `WeaveConfigSchema`.
 *
 * Top-level `log_level` is rejected with a `ValidationError` — it must be
 * placed inside a `settings { log_level INFO }` block instead.
 */
function astToPlainObject(nodes: AstNode[]): {
  plain: Record<string, unknown>;
  topLevelLogLevel: boolean;
  invalidSettingsShape: boolean;
} {
  const agents: Record<string, unknown> = {};
  const categories: Record<string, unknown> = {};
  const disabled: Record<string, string[]> = {};
  const workflows: Record<string, unknown> = {};
  let settingsBlock: Record<string, unknown> | undefined;
  let topLevelLogLevel = false;
  let invalidSettingsShape = false;

  for (const node of nodes) {
    switch (node.type) {
      case "agent":
        agents[node.name] = propertiesToObject(node.properties);
        break;

      case "category":
        categories[node.name] = propertiesToObject(node.properties);
        break;

      case "workflow": {
        const workflowObj: Record<string, unknown> = {
          ...propertiesToObject(node.properties),
          steps: node.steps.map((s) => {
            const stepObj = transformStepProperties(s.name, s.properties);
            if (s.insert_before !== undefined)
              stepObj.insert_before = s.insert_before;
            if (s.insert_after !== undefined)
              stepObj.insert_after = s.insert_after;
            return stepObj;
          }),
        };
        if (node.extends !== undefined) workflowObj.extends = node.extends;
        workflows[node.name] = workflowObj;
        break;
      }

      case "disable":
        disabled[node.target] = [
          ...(disabled[node.target] ?? []),
          ...node.items,
        ];
        break;

      case "setting":
        if (node.key === "log_level") {
          // Top-level log_level is rejected — must be inside settings { }
          topLevelLogLevel = true;
        } else if (node.key === "settings") {
          // settings { ... } block — extract as nested object
          if (node.value.kind === "block") {
            settingsBlock = propertiesToObject(node.value.properties);
          } else {
            invalidSettingsShape = true;
          }
        }
        // All other top-level settings are silently ignored (not part of schema)
        break;
    }
  }

  const result: Record<string, unknown> = {};
  if (Object.keys(agents).length > 0) result.agents = agents;
  if (Object.keys(categories).length > 0) result.categories = categories;
  if (Object.keys(disabled).length > 0) result.disabled = disabled;
  if (Object.keys(workflows).length > 0) result.workflows = workflows;
  if (settingsBlock !== undefined) result.settings = settingsBlock;

  return { plain: result, topLevelLogLevel, invalidSettingsShape };
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
 *
 * Top-level `log_level` is rejected with a `ValidationError` — it must be
 * placed inside a `settings { log_level INFO }` block.
 */
export function validate(
  ast: AstNode[],
): Result<WeaveConfig, ValidationError[]> {
  const { plain, topLevelLogLevel, invalidSettingsShape } =
    astToPlainObject(ast);

  if (invalidSettingsShape) {
    return err([
      {
        type: "ValidationError",
        path: "settings",
        message: "settings must be a block: settings { ... }",
      },
    ]);
  }

  if (topLevelLogLevel) {
    return err([
      {
        type: "ValidationError",
        path: "log_level",
        message:
          "top-level log_level is not allowed; use settings { log_level INFO } instead",
      },
    ]);
  }

  const parsed = WeaveConfigSchema.safeParse(plain);

  if (!parsed.success) {
    return err(zodErrorToValidationErrors(parsed.error));
  }

  return ok(parsed.data);
}
