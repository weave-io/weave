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
// Validation diagnostic and AST structure bounds
// ---------------------------------------------------------------------------

export const MAX_VALIDATION_ISSUES = 32;
export const MAX_VALIDATION_PATH_LENGTH = 256;
export const MAX_VALIDATION_MESSAGE_LENGTH = 512;
export const MAX_VALIDATION_DIAGNOSTIC_SIZE = 8 * 1024;
export const VALIDATION_DIAGNOSTICS_TRUNCATED =
  "[validation diagnostics truncated]";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STRUCTURAL_ERROR_COLLECTION_LIMIT = MAX_VALIDATION_ISSUES + 1;

function truncateDiagnosticPart(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const marker = "... [truncated]";
  return `${value.slice(0, maxLength - marker.length)}${marker}`;
}

function boundValidationErrors(errors: ValidationError[]): ValidationError[] {
  let partWasTruncated = false;
  const sanitized = errors.map((error) => {
    const path = truncateDiagnosticPart(error.path, MAX_VALIDATION_PATH_LENGTH);
    const message = truncateDiagnosticPart(
      error.message,
      MAX_VALIDATION_MESSAGE_LENGTH,
    );
    partWasTruncated ||= path !== error.path || message !== error.message;
    return { ...error, path, message };
  });
  const aggregateSize = sanitized.reduce(
    (size, error) => size + error.path.length + error.message.length,
    0,
  );
  if (
    !partWasTruncated &&
    sanitized.length <= MAX_VALIDATION_ISSUES &&
    aggregateSize <= MAX_VALIDATION_DIAGNOSTIC_SIZE
  ) {
    return sanitized;
  }

  const bounded: ValidationError[] = [];
  const markerSize = VALIDATION_DIAGNOSTICS_TRUNCATED.length;
  let size = 0;
  for (const error of sanitized) {
    if (bounded.length >= MAX_VALIDATION_ISSUES - 1) break;
    const errorSize = error.path.length + error.message.length;
    if (size + errorSize + markerSize > MAX_VALIDATION_DIAGNOSTIC_SIZE) break;
    bounded.push(error);
    size += errorSize;
  }
  bounded.push({
    type: "ValidationError",
    path: "",
    message: VALIDATION_DIAGNOSTICS_TRUNCATED,
  });
  return bounded;
}

function structuralError(
  errors: ValidationError[],
  path: string,
  message: string,
  property?: Property,
): void {
  if (errors.length >= STRUCTURAL_ERROR_COLLECTION_LIMIT) return;
  errors.push({
    type: "ValidationError",
    path,
    message,
    ...(property === undefined
      ? {}
      : { line: property.pos.line, column: property.pos.column }),
  });
}

function validatePropertyStructure(
  properties: Property[],
  path: string,
  errors: ValidationError[],
  triggerArrayOnly: boolean,
  rejectBareFast: boolean,
): void {
  const seen = new Set<string>();
  for (const property of properties) {
    const propertyPath =
      path.length > 0 ? `${path}.${property.key}` : property.key;
    if (DANGEROUS_KEYS.has(property.key)) {
      structuralError(
        errors,
        propertyPath,
        `dangerous property key '${property.key}' is not allowed`,
        property,
      );
      continue;
    }
    if (seen.has(property.key)) {
      structuralError(
        errors,
        propertyPath,
        `duplicate property '${property.key}'`,
        property,
      );
      continue;
    }
    seen.add(property.key);

    if (rejectBareFast && property.key === "fast" && property.bare === true) {
      structuralError(
        errors,
        propertyPath,
        "fast requires the explicit literal: fast true",
        property,
      );
    }
    if (
      triggerArrayOnly &&
      property.key === "triggers" &&
      property.value.kind === "array"
    ) {
      for (const [index, element] of property.value.elements.entries()) {
        if (element.kind !== "string") {
          structuralError(
            errors,
            `${propertyPath}.${index}`,
            "trigger entries must be quoted strings",
            property,
          );
        }
      }
    }
    if (property.value.kind === "block") {
      if (property.key === "extension_points") {
        const normalizedKeys = new Map<string, string>();
        for (const nested of property.value.properties) {
          const normalized =
            nested.key === "before-plan" ? "before_plan" : nested.key;
          const previous = normalizedKeys.get(normalized);
          if (previous !== undefined && previous !== nested.key) {
            structuralError(
              errors,
              `${propertyPath}.${nested.key}`,
              `duplicate normalized property '${normalized}'`,
              nested,
            );
          }
          normalizedKeys.set(normalized, nested.key);
        }
      }
      validatePropertyStructure(
        property.value.properties,
        propertyPath,
        errors,
        false,
        false,
      );
    }
  }
}

function validateAstStructure(nodes: AstNode[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const declarations = {
    agent: new Set<string>(),
    category: new Set<string>(),
    workflow: new Set<string>(),
  };
  const settingKeys = new Set<string>();

  for (const node of nodes) {
    if (
      node.type === "agent" ||
      node.type === "category" ||
      node.type === "workflow"
    ) {
      const declarationGroup =
        node.type === "category" ? "categories" : `${node.type}s`;
      const path = `${declarationGroup}.${node.name}`;
      if (DANGEROUS_KEYS.has(node.name)) {
        structuralError(
          errors,
          path,
          `dangerous ${node.type} name '${node.name}' is not allowed`,
        );
      }
      const names = declarations[node.type];
      if (names.has(node.name)) {
        structuralError(
          errors,
          path,
          `duplicate ${node.type} declaration '${node.name}'`,
        );
      }
      names.add(node.name);
      validatePropertyStructure(
        node.properties,
        path,
        errors,
        node.type === "agent" || node.type === "category",
        node.type === "agent" || node.type === "category",
      );
      if (node.type === "workflow") {
        const stepNames = new Set<string>();
        for (const step of node.steps) {
          const stepPath = `${path}.steps.${step.name}`;
          if (DANGEROUS_KEYS.has(step.name)) {
            structuralError(
              errors,
              stepPath,
              `dangerous step name '${step.name}' is not allowed`,
            );
          }
          if (stepNames.has(step.name)) {
            structuralError(
              errors,
              stepPath,
              `duplicate step declaration '${step.name}'`,
            );
          }
          stepNames.add(step.name);
          validatePropertyStructure(
            step.properties,
            stepPath,
            errors,
            false,
            false,
          );
        }
      }
      continue;
    }
    if (node.type === "setting") {
      if (DANGEROUS_KEYS.has(node.key)) {
        structuralError(
          errors,
          node.key,
          `dangerous setting key '${node.key}' is not allowed`,
        );
      }
      if (settingKeys.has(node.key)) {
        structuralError(errors, node.key, `duplicate setting '${node.key}'`);
      }
      settingKeys.add(node.key);
      if (node.value.kind === "block") {
        validatePropertyStructure(
          node.value.properties,
          node.key,
          errors,
          false,
          false,
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// AST → plain object helpers
// ---------------------------------------------------------------------------

function nullPrototypeRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function defineOwn(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

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
  const obj = nullPrototypeRecord();
  for (const prop of props) {
    defineOwn(obj, prop.key, astValueToPlain(prop.value));
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
  const obj = nullPrototypeRecord();
  defineOwn(obj, "name", stepName);

  for (const prop of properties) {
    if (prop.key === "name") {
      defineOwn(obj, "display_name", astValueToPlain(prop.value));
      continue;
    }

    if (prop.key === "completion") {
      if (prop.value.kind === "identifier") {
        const iv = prop.value as IdentifierValue;
        defineOwn(obj, "completion", { method: iv.value });
      } else if (prop.value.kind === "block") {
        const bv = prop.value as BlockValue;
        const blockObj = propertiesToObject(bv.properties);
        const { __name: methodRaw, ...params } = blockObj;
        defineOwn(obj, "completion", {
          method: methodRaw as string,
          ...params,
        });
      }
      continue;
    }

    defineOwn(obj, prop.key, astValueToPlain(prop.value));
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
  const result = nullPrototypeRecord();
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key === "before-plan" ? "before_plan" : key;
    defineOwn(result, normalized, value);
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
  const agents = nullPrototypeRecord();
  const categories = nullPrototypeRecord();
  const disabled = nullPrototypeRecord() as Record<string, string[]>;
  const workflows = nullPrototypeRecord();
  const extendBeforePlanSteps: string[] = [];
  const seenExtendBeforePlanSteps = new Set<string>();
  let settingsBlock: Record<string, unknown> | undefined;
  let topLevelLogLevel = false;
  let invalidSettingsShape = false;

  for (const node of nodes) {
    switch (node.type) {
      case "agent":
        defineOwn(agents, node.name, propertiesToObject(node.properties));
        break;

      case "category":
        defineOwn(categories, node.name, propertiesToObject(node.properties));
        break;

      case "workflow": {
        const rawProps = propertiesToObject(node.properties);

        // Normalise extension_points block: convert hyphenated keys to underscored.
        if (
          rawProps.extension_points !== null &&
          typeof rawProps.extension_points === "object" &&
          !Array.isArray(rawProps.extension_points)
        ) {
          defineOwn(
            rawProps,
            "extension_points",
            normalizeExtensionPoints(
              rawProps.extension_points as Record<string, unknown>,
            ),
          );
        }

        const workflowObj = nullPrototypeRecord();
        for (const [key, value] of Object.entries(rawProps)) {
          defineOwn(workflowObj, key, value);
        }
        defineOwn(
          workflowObj,
          "steps",
          node.steps.map((s) => {
            const stepObj = transformStepProperties(s.name, s.properties);
            if (s.insert_before !== undefined)
              defineOwn(stepObj, "insert_before", s.insert_before);
            if (s.insert_after !== undefined)
              defineOwn(stepObj, "insert_after", s.insert_after);
            return stepObj;
          }),
        );
        if (node.extends !== undefined)
          defineOwn(workflowObj, "extends", node.extends);
        defineOwn(workflows, node.name, workflowObj);
        break;
      }

      case "disable":
        defineOwn(disabled, node.target, [
          ...(disabled[node.target] ?? []),
          ...node.items,
        ]);
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

  const result = nullPrototypeRecord();
  if (Object.keys(agents).length > 0) defineOwn(result, "agents", agents);
  if (Object.keys(categories).length > 0)
    defineOwn(result, "categories", categories);
  if (Object.keys(disabled).length > 0) defineOwn(result, "disabled", disabled);
  if (Object.keys(workflows).length > 0)
    defineOwn(result, "workflows", workflows);
  if (extendBeforePlanSteps.length > 0)
    defineOwn(result, "extend_before_plan", { steps: extendBeforePlanSteps });
  if (settingsBlock !== undefined) defineOwn(result, "settings", settingsBlock);

  return { plain: result, topLevelLogLevel, invalidSettingsShape };
}

// ---------------------------------------------------------------------------
// Zod error → ValidationError mapping
// ---------------------------------------------------------------------------

function zodErrorToValidationErrors(zodError: ZodError): ValidationError[] {
  return boundValidationErrors(
    zodError.issues
      .slice(0, STRUCTURAL_ERROR_COLLECTION_LIMIT)
      .map((issue) => ({
        type: "ValidationError" as const,
        path: issue.path.join("."),
        message: issue.message,
      })),
  );
}

// ---------------------------------------------------------------------------
// Opaque adapter settings validation
// ---------------------------------------------------------------------------

function canonicalAstJson(value: AstValue): string {
  if (value.kind === "array")
    return `[${value.elements.map(canonicalAstJson).join(",")}]`;
  if (value.kind === "block") {
    const entries = value.properties
      .map(
        (property) => [property.key, canonicalAstJson(property.value)] as const,
      )
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
    const adapters = node.value.properties.find(
      (property) => property.key === "adapters",
    );
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
      const bytes = new TextEncoder().encode(
        canonicalAstJson(harness.value),
      ).byteLength;
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
  const structuralErrors = validateAstStructure(ast);
  const adapterErrors = validateOpaqueAdapterSettings(ast);
  if (structuralErrors.length > 0) {
    return err(boundValidationErrors([...structuralErrors, ...adapterErrors]));
  }

  const { plain, topLevelLogLevel, invalidSettingsShape } =
    astToPlainObject(ast);

  if (invalidSettingsShape) {
    return err(
      boundValidationErrors([
        {
          type: "ValidationError",
          path: "settings",
          message: "settings must be a block: settings { ... }",
        },
      ]),
    );
  }

  if (topLevelLogLevel) {
    return err(
      boundValidationErrors([
        ...adapterErrors,
        {
          type: "ValidationError",
          path: "log_level",
          message:
            "top-level log_level is not allowed; use settings { log_level INFO } instead",
        },
      ]),
    );
  }

  if (adapterErrors.length > 0)
    return err(boundValidationErrors(adapterErrors));

  const parsed = WeaveConfigSchema.safeParse(plain);

  if (!parsed.success) {
    return err(zodErrorToValidationErrors(parsed.error));
  }

  return ok(parsed.data);
}
