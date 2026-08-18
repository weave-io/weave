/**
 * Validates an `AstNode[]` produced by the parser against the Zod schemas,
 * returning a fully-typed `WeaveConfig` or an array of `ValidationError`s.
 */

import { err, ok, Result } from "neverthrow";
import { type ZodError, z } from "zod";
import type { AstNode, AstValue, Property, StepBlock } from "./ast.js";
import {
  boundConfigErrors,
  CONFIG_ERRORS_TRUNCATED,
  MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE,
  MAX_CONFIG_ERROR_FIELD_LENGTH,
  MAX_CONFIG_ERROR_ISSUES,
  MAX_CONFIG_ERROR_PATH_LENGTH,
} from "./config-error-policy.js";
import type { ValidationError } from "./errors.js";
import { copySafeGraph } from "./safe-graph-copy.js";
import {
  type JsonValue,
  type WeaveConfig,
  WeaveConfigSchema,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Validation diagnostic and AST structure bounds
// ---------------------------------------------------------------------------

export const MAX_VALIDATION_ISSUES = MAX_CONFIG_ERROR_ISSUES;
export const MAX_VALIDATION_PATH_LENGTH = MAX_CONFIG_ERROR_PATH_LENGTH;
export const MAX_VALIDATION_MESSAGE_LENGTH = MAX_CONFIG_ERROR_FIELD_LENGTH;
export const MAX_VALIDATION_DIAGNOSTIC_SIZE = MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE;
export const VALIDATION_DIAGNOSTICS_TRUNCATED = CONFIG_ERRORS_TRUNCATED;

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STRUCTURAL_ERROR_COLLECTION_LIMIT = MAX_VALIDATION_ISSUES + 1;

type ValidatorJsonObject = {
  [key: string]: JsonValue;
};

type DisabledItemsByTarget = {
  [key: string]: string[];
};

type AstPlainConversion = {
  plain: ValidatorJsonObject;
  topLevelLogLevel: boolean;
  hasInvalidSettingsValue: boolean;
};

const SourcePosSchema = z.object({
  line: z.number(),
  column: z.number(),
});

const PropertySchema: z.ZodType<Property> = z.lazy(() =>
  z.object({
    key: z.string(),
    value: copiedAstValueSchema(),
    pos: SourcePosSchema,
    bare: z.literal(true).optional(),
  }),
);

const AstValueSchema: z.ZodType<AstValue> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("string"),
      value: z.string(),
      pos: SourcePosSchema,
    }),
    z.object({
      kind: z.literal("number"),
      value: z.number(),
      pos: SourcePosSchema,
    }),
    z.object({
      kind: z.literal("boolean"),
      value: z.boolean(),
      pos: SourcePosSchema,
    }),
    z.object({
      kind: z.literal("null"),
      value: z.null(),
      pos: SourcePosSchema,
    }),
    z.object({
      kind: z.literal("identifier"),
      value: z.string(),
      pos: SourcePosSchema,
    }),
    z.object({
      kind: z.literal("array"),
      elements: z.array(copiedAstValueSchema()),
      pos: SourcePosSchema,
    }),
    z.object({
      kind: z.literal("block"),
      properties: z.array(copiedPropertySchema()),
      pos: SourcePosSchema,
    }),
  ]),
);

function copiedPropertySchema(): z.ZodType<Property> {
  return PropertySchema;
}

function copiedAstValueSchema(): z.ZodType<AstValue> {
  return AstValueSchema;
}

const StepBlockSchema: z.ZodType<StepBlock> = z.object({
  name: z.string(),
  properties: z.array(PropertySchema),
  pos: SourcePosSchema,
  insert_before: z.string().optional(),
  insert_after: z.string().optional(),
});

const CopiedAstNodeListSchema: z.ZodType<AstNode[]> = z.array(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("agent"),
      name: z.string(),
      properties: z.array(PropertySchema),
      pos: SourcePosSchema,
    }),
    z.object({
      type: z.literal("category"),
      name: z.string(),
      properties: z.array(PropertySchema),
      pos: SourcePosSchema,
    }),
    z.object({
      type: z.literal("workflow"),
      name: z.string(),
      properties: z.array(PropertySchema),
      steps: z.array(StepBlockSchema),
      pos: SourcePosSchema,
      extends: z.string().optional(),
    }),
    z.object({
      type: z.literal("disable"),
      target: z.enum(["agents", "hooks", "skills"]),
      items: z.array(z.string()),
      pos: SourcePosSchema,
    }),
    z.object({
      type: z.literal("setting"),
      key: z.string(),
      value: AstValueSchema,
      pos: SourcePosSchema,
    }),
    z.object({
      type: z.literal("extend_before_plan"),
      steps: z.array(z.string()),
      pos: SourcePosSchema,
    }),
  ]),
);

function boundValidationErrors(errors: ValidationError[]): ValidationError[] {
  return boundConfigErrors<ValidationError>(errors, () => ({
    type: "ValidationError",
    path: "",
    message: CONFIG_ERRORS_TRUNCATED,
  }));
}

function structuralError(
  errors: ValidationError[],
  path: string,
  message: string,
  property?: Property,
): void {
  if (errors.length >= STRUCTURAL_ERROR_COLLECTION_LIMIT) return;
  const error: ValidationError = {
    type: "ValidationError",
    path,
    message,
  };
  if (property !== undefined) {
    error.line = property.pos.line;
    error.column = property.pos.column;
  }
  errors.push(error);
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

function validateDestinationOwnership(
  properties: readonly Property[],
  path: string,
  errors: ValidationError[],
  reservedDestinations: ReadonlySet<string>,
  destinationOf: (property: Property) => string = (property) => property.key,
): void {
  const owners = new Map<string, Property>();
  for (const property of properties) {
    const destination = destinationOf(property);
    if (reservedDestinations.has(destination)) {
      structuralError(
        errors,
        `${path}.${property.key}`,
        `property '${property.key}' collides with generated '${destination}'`,
        property,
      );
      continue;
    }
    const previous = owners.get(destination);
    if (previous !== undefined && previous.key !== property.key) {
      structuralError(
        errors,
        `${path}.${property.key}`,
        `properties '${previous.key}' and '${property.key}' both map to '${destination}'`,
        property,
      );
    }
    owners.set(destination, property);
  }
}

function validateCompletionDestinationOwnership(
  properties: readonly Property[],
  path: string,
  errors: ValidationError[],
): void {
  for (const property of properties) {
    if (property.key !== "completion" || property.value.kind !== "block") {
      continue;
    }
    const hasGeneratedMethod = property.value.properties.some(
      (nested) => nested.key === "__name",
    );
    if (!hasGeneratedMethod) continue;
    for (const nested of property.value.properties) {
      if (nested.key === "method") {
        structuralError(
          errors,
          `${path}.completion.method`,
          "property 'method' collides with generated 'method'",
          nested,
        );
      }
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
        validateDestinationOwnership(
          node.properties,
          path,
          errors,
          new Set(["extends", "steps"]),
        );
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
          validateDestinationOwnership(
            step.properties,
            stepPath,
            errors,
            new Set(["insert_after", "insert_before", "name"]),
            (property) =>
              property.key === "name" ? "display_name" : property.key,
          );
          validateCompletionDestinationOwnership(
            step.properties,
            stepPath,
            errors,
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

function emptyValidatorJsonObject(): ValidatorJsonObject {
  return Object.setPrototypeOf({}, null);
}

function emptyDisabledItemsByTarget(): DisabledItemsByTarget {
  return Object.setPrototypeOf({}, null);
}

function defineOwnProperty(
  record: ValidatorJsonObject | DisabledItemsByTarget,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isValidatorJsonObject(value: JsonValue): value is ValidatorJsonObject {
  if (value === null || Array.isArray(value)) return false;
  return value instanceof Object || Object.getPrototypeOf(value) === null;
}

/**
 * Convert an `AstValue` into a plain JS value suitable for Zod parsing.
 */
function astValueToPlain(value: AstValue): JsonValue {
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
function propertiesToObject(props: Property[]): ValidatorJsonObject {
  const obj = emptyValidatorJsonObject();
  for (const prop of props) {
    defineOwnProperty(obj, prop.key, astValueToPlain(prop.value));
  }
  return obj;
}

function namedCompletionObject(
  blockProperties: Property[],
): ValidatorJsonObject {
  const blockObj = propertiesToObject(blockProperties);
  const completion = emptyValidatorJsonObject();
  const methodRaw = blockObj.__name;
  if (methodRaw !== undefined) {
    defineOwnProperty(completion, "method", methodRaw);
  }
  for (const [key, value] of Object.entries(blockObj)) {
    if (key === "__name") continue;
    defineOwnProperty(completion, key, value);
  }
  return completion;
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
): ValidatorJsonObject {
  const obj = emptyValidatorJsonObject();
  defineOwnProperty(obj, "name", stepName);

  for (const prop of properties) {
    if (prop.key === "name") {
      defineOwnProperty(obj, "display_name", astValueToPlain(prop.value));
      continue;
    }

    if (prop.key === "completion") {
      if (prop.value.kind === "identifier") {
        const completion = emptyValidatorJsonObject();
        defineOwnProperty(completion, "method", prop.value.value);
        defineOwnProperty(obj, "completion", completion);
      } else if (prop.value.kind === "block") {
        defineOwnProperty(
          obj,
          "completion",
          namedCompletionObject(prop.value.properties),
        );
      }
      continue;
    }

    defineOwnProperty(obj, prop.key, astValueToPlain(prop.value));
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
  raw: ValidatorJsonObject,
): ValidatorJsonObject {
  const result = emptyValidatorJsonObject();
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key === "before-plan" ? "before_plan" : key;
    defineOwnProperty(result, normalized, value);
  }
  return result;
}

/**
 * Walk `AstNode[]` and build a plain object shaped for `WeaveConfigSchema`.
 *
 * Top-level `log_level` is rejected with a `ValidationError` — it must be
 * placed inside a `settings { log_level INFO }` block instead.
 */
function astToPlainObject(nodes: AstNode[]): AstPlainConversion {
  const agents = emptyValidatorJsonObject();
  const categories = emptyValidatorJsonObject();
  const disabled = emptyDisabledItemsByTarget();
  const workflows = emptyValidatorJsonObject();
  const extendBeforePlanSteps: string[] = [];
  const seenExtendBeforePlanSteps = new Set<string>();
  let settingsBlock: ValidatorJsonObject | undefined;
  let topLevelLogLevel = false;
  let hasInvalidSettingsValue = false;

  for (const node of nodes) {
    switch (node.type) {
      case "agent":
        defineOwnProperty(
          agents,
          node.name,
          propertiesToObject(node.properties),
        );
        break;

      case "category":
        defineOwnProperty(
          categories,
          node.name,
          propertiesToObject(node.properties),
        );
        break;

      case "workflow": {
        const rawProps = propertiesToObject(node.properties);
        const extensionPoints = rawProps.extension_points;
        if (
          extensionPoints !== undefined &&
          isValidatorJsonObject(extensionPoints)
        ) {
          defineOwnProperty(
            rawProps,
            "extension_points",
            normalizeExtensionPoints(extensionPoints),
          );
        }

        const workflowObj = emptyValidatorJsonObject();
        for (const [key, value] of Object.entries(rawProps)) {
          defineOwnProperty(workflowObj, key, value);
        }
        defineOwnProperty(
          workflowObj,
          "steps",
          node.steps.map((s) => {
            const stepObj = transformStepProperties(s.name, s.properties);
            if (s.insert_before !== undefined)
              defineOwnProperty(stepObj, "insert_before", s.insert_before);
            if (s.insert_after !== undefined)
              defineOwnProperty(stepObj, "insert_after", s.insert_after);
            return stepObj;
          }),
        );
        if (node.extends !== undefined)
          defineOwnProperty(workflowObj, "extends", node.extends);
        defineOwnProperty(workflows, node.name, workflowObj);
        break;
      }

      case "disable":
        defineOwnProperty(disabled, node.target, [
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
            hasInvalidSettingsValue = true;
          }
        }
        // All other top-level settings are silently ignored (not part of schema)
        break;
    }
  }

  const result = emptyValidatorJsonObject();
  if (Object.keys(agents).length > 0)
    defineOwnProperty(result, "agents", agents);
  if (Object.keys(categories).length > 0)
    defineOwnProperty(result, "categories", categories);
  if (Object.keys(disabled).length > 0)
    defineOwnProperty(result, "disabled", disabled);
  if (Object.keys(workflows).length > 0)
    defineOwnProperty(result, "workflows", workflows);
  if (extendBeforePlanSteps.length > 0)
    defineOwnProperty(result, "extend_before_plan", {
      steps: extendBeforePlanSteps,
    });
  if (settingsBlock !== undefined)
    defineOwnProperty(result, "settings", settingsBlock);

  return { plain: result, topLevelLogLevel, hasInvalidSettingsValue };
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
function invalidAstError(message: string): ValidationError[] {
  return boundValidationErrors([
    {
      type: "ValidationError",
      path: "",
      message,
    },
  ]);
}

function validateCopiedAst(
  safeAst: AstNode[],
): Result<WeaveConfig, ValidationError[]> {
  const structuralErrors = validateAstStructure(safeAst);
  const adapterErrors = validateOpaqueAdapterSettings(safeAst);
  if (structuralErrors.length > 0) {
    return err(boundValidationErrors([...structuralErrors, ...adapterErrors]));
  }

  const { plain, topLevelLogLevel, hasInvalidSettingsValue } =
    astToPlainObject(safeAst);

  if (hasInvalidSettingsValue) {
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

const safelyValidateCopiedAst = Result.fromThrowable(validateCopiedAst, () =>
  invalidAstError("AST input has an invalid shape"),
);

/**
 * Direct AST input is copied first, then parsed into `AstNode[]`.
 * The type parameter is unconstrained so hostile graphs can be rejected at the
 * copy/parse boundary without a typed assertion.
 */
export function validate<DirectAst>(
  ast: DirectAst,
): Result<WeaveConfig, ValidationError[]> {
  const copied = copySafeGraph(ast);
  if (copied.isErr()) return err(invalidAstError(copied.error.message));
  if (!Array.isArray(copied.value)) {
    return err(invalidAstError("AST input must be an array"));
  }
  const parsedAst = CopiedAstNodeListSchema.safeParse(copied.value);
  if (!parsedAst.success) {
    return err(invalidAstError("AST input has an invalid shape"));
  }
  return safelyValidateCopiedAst(parsedAst.data).andThen((result) => result);
}
