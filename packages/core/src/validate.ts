/**
 * Validates an `AstNode[]` produced by the parser against the Zod schemas,
 * returning a fully-typed `WeaveConfig` or an array of `ValidationError`s.
 */

import { err, ok, Result } from "neverthrow";
import type { ZodError } from "zod";
import type {
  AstNode,
  AstValue,
  BlockValue,
  IdentifierValue,
  Property,
} from "./ast.js";
import {
  boundConfigErrors,
  CONFIG_ERRORS_TRUNCATED,
} from "./config-error-policy.js";
import type { ValidationError } from "./errors.js";
import { copySafeGraph } from "./safe-graph-copy.js";
import { type WeaveConfig, WeaveConfigSchema } from "./schema.js";

const UNSAFE_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPosition(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.line) &&
    Number.isSafeInteger(value.column) &&
    (value.line as number) >= 0 &&
    (value.column as number) >= 0
  );
}

function isName(value: unknown): value is string {
  return typeof value === "string" && !UNSAFE_NAMES.has(value);
}

function isAstValue(value: unknown): value is AstValue {
  if (!isRecord(value) || !isPosition(value.pos)) return false;
  switch (value.kind) {
    case "string":
    case "identifier":
      return typeof value.value === "string";
    case "number":
      return typeof value.value === "number" && Number.isFinite(value.value);
    case "boolean":
      return typeof value.value === "boolean";
    case "array":
      return Array.isArray(value.elements) && value.elements.every(isAstValue);
    case "block":
      return isProperties(value.properties);
    default:
      return false;
  }
}

function isProperties(value: unknown): value is Property[] {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  for (const property of value) {
    if (
      !isRecord(property) ||
      !isName(property.key) ||
      names.has(property.key) ||
      !isPosition(property.pos) ||
      !isAstValue(property.value)
    )
      return false;
    names.add(property.key);
  }
  return true;
}

function isAstNode(value: unknown): value is AstNode {
  if (!isRecord(value) || !isPosition(value.pos)) return false;
  switch (value.type) {
    case "agent":
    case "category":
      return isName(value.name) && isProperties(value.properties);
    case "workflow": {
      if (
        !isName(value.name) ||
        !isProperties(value.properties) ||
        !Array.isArray(value.steps) ||
        (value.extends !== undefined && typeof value.extends !== "string")
      )
        return false;
      const names = new Set<string>();
      return value.steps.every((step) => {
        if (
          !isRecord(step) ||
          !isName(step.name) ||
          names.has(step.name) ||
          !isPosition(step.pos) ||
          !isProperties(step.properties) ||
          (step.insert_before !== undefined &&
            typeof step.insert_before !== "string") ||
          (step.insert_after !== undefined &&
            typeof step.insert_after !== "string")
        )
          return false;
        names.add(step.name);
        return true;
      });
    }
    case "setting":
      return isName(value.key) && isAstValue(value.value);
    case "disable":
      return (
        typeof value.target === "string" &&
        ["agents", "hooks", "skills"].includes(value.target) &&
        Array.isArray(value.items) &&
        value.items.every((item) => typeof item === "string")
      );
    case "extend_before_plan":
      return (
        Array.isArray(value.steps) &&
        value.steps.every((step) => typeof step === "string")
      );
    default:
      return false;
  }
}

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
  const obj: Record<string, unknown> = Object.create(null);
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
  const obj: Record<string, unknown> = Object.create(null);
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
  const result: Record<string, unknown> = Object.create(null);
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
  const agents: Record<string, unknown> = Object.create(null);
  const categories: Record<string, unknown> = Object.create(null);
  const disabled: Record<string, string[]> = Object.create(null);
  const workflows: Record<string, unknown> = Object.create(null);
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
  const invalid: ValidationError[] = [
    {
      type: "ValidationError",
      path: "",
      message:
        "AST input must be bounded plain data with valid nodes, safe names, and unique properties",
    },
  ];
  const copied = copySafeGraph(ast);
  if (copied.isErr()) return err(invalid);
  const safeAst: unknown = copied.value;
  if (!Array.isArray(safeAst) || !safeAst.every(isAstNode)) return err(invalid);
  return Result.fromThrowable(
    () => validateCopiedAst(safeAst),
    () => invalid,
  )()
    .andThen((result) => result)
    .mapErr((errors) =>
      boundConfigErrors(errors, () => ({
        type: "ValidationError",
        path: "",
        message: CONFIG_ERRORS_TRUNCATED,
      })),
    );
}

function validateCopiedAst(
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
