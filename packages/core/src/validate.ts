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
    case "null":
      return null;
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
 * Normalise an `extension_points` block's properties.
 *
 * The DSL uses hyphenated identifiers as bare flags inside the block:
 * ```weave
 * extension_points {
 *   before-plan
 * }
 * ```
 * The parser produces `{ key: "before-plan", value: BooleanValue(true) }`.
 * This function converts the hyphenated key to the schema key `before_plan`.
 */
function normalizeExtensionPoints(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key === "before-plan" ? "before_plan" : key;
    result[normalized] = value;
  }
  return result;
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
  const extendBeforePlanSteps: string[] = [];
  const seenExtendBeforePlanSteps = new Set<string>();
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
        const rawProps = propertiesToObject(node.properties);

        // Normalise extension_points block: convert hyphenated keys to underscored.
        if (
          rawProps.extension_points !== null &&
          typeof rawProps.extension_points === "object" &&
          !Array.isArray(rawProps.extension_points)
        ) {
          rawProps.extension_points = normalizeExtensionPoints(
            rawProps.extension_points as Record<string, unknown>,
          );
        }

        const workflowObj: Record<string, unknown> = {
          ...rawProps,
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

      case "extend_before_plan":
        // `extend before-plan ["step-a", "step-b"]` — union-merge into a single
        // global step list. v1 has no per-workflow targeting.
        for (const step of node.steps) {
          if (!seenExtendBeforePlanSteps.has(step)) {
            seenExtendBeforePlanSteps.add(step);
            extendBeforePlanSteps.push(step);
          }
        }
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
  if (extendBeforePlanSteps.length > 0)
    result.extend_before_plan = { steps: extendBeforePlanSteps };
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
// Opaque adapter settings validation
// ---------------------------------------------------------------------------

function canonicalAstJson(value: AstValue): string {
  if (value.kind === "array")
    return `[${value.elements.map(canonicalAstJson).join(",")}]`;
  if (value.kind === "block") {
    const entries = value.properties
      .map((property) => [property.key, canonicalAstJson(property.value)] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, raw]) => `${JSON.stringify(key)}:${raw}`).join(",")}}`;
  }
  return JSON.stringify(astValueToPlain(value));
}

function validateAdapterAst(
  value: AstValue,
  path: string,
  depth: number,
  errors: ValidationError[],
): void {
  if (value.kind === "identifier") {
    errors.push({
      type: "ValidationError",
      path,
      message: `adapter settings accept JSON values only; identifier '${value.value}' is not valid`,
    });
    return;
  }
  if (value.kind === "number" && !Number.isFinite(value.value)) {
    errors.push({
      type: "ValidationError",
      path,
      message: "adapter settings numbers must be finite",
    });
    return;
  }
  if (depth > 4) {
    errors.push({
      type: "ValidationError",
      path,
      message: "adapter setting nesting exceeds maximum depth of 4",
    });
    return;
  }
  if (value.kind === "array") {
    value.elements.forEach((entry, index) => {
      validateAdapterAst(entry, `${path}.${index}`, depth + 1, errors);
    });
    return;
  }
  if (value.kind !== "block") return;

  const seen = new Set<string>();
  for (const property of value.properties) {
    const propertyPath = `${path}.${property.key}`;
    if (seen.has(property.key)) {
      errors.push({
        type: "ValidationError",
        path: propertyPath,
        message: `duplicate adapter setting key '${property.key}'`,
      });
      continue;
    }
    seen.add(property.key);
    validateAdapterAst(property.value, propertyPath, depth + 1, errors);
  }
}

function validateOpaqueAdapterSettings(ast: AstNode[]): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const node of ast) {
    if (node.type !== "setting" || node.key !== "settings") continue;
    if (node.value.kind !== "block") continue;
    const adapters = node.value.properties.find((property) => property.key === "adapters");
    if (adapters === undefined || adapters.value.kind !== "block") continue;
    const harnesses = new Set<string>();
    for (const harness of adapters.value.properties) {
      const path = `settings.adapters.${harness.key}`;
      if (harnesses.has(harness.key)) {
        errors.push({
          type: "ValidationError",
          path,
          message: `duplicate adapter setting key '${harness.key}'`,
        });
        continue;
      }
      harnesses.add(harness.key);
      validateAdapterAst(harness.value, path, 0, errors);
      const bytes = new TextEncoder().encode(canonicalAstJson(harness.value)).byteLength;
      if (bytes > 64 * 1024) {
        errors.push({
          type: "ValidationError",
          path,
          message: `adapter settings exceed the 64 KiB canonical JSON limit (${bytes} bytes)`,
        });
      }
    }
  }
  return errors;
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
  const adapterErrors = validateOpaqueAdapterSettings(ast);

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
      ...adapterErrors,
      {
        type: "ValidationError",
        path: "log_level",
        message:
          "top-level log_level is not allowed; use settings { log_level INFO } instead",
      },
    ]);
  }

  if (adapterErrors.length > 0) return err(adapterErrors);

  const parsed = WeaveConfigSchema.safeParse(plain);

  if (!parsed.success) {
    return err(zodErrorToValidationErrors(parsed.error));
  }

  return ok(parsed.data);
}
