import { z } from "zod";
import type {
  SafeGraphCopyBudget,
  SafeGraphObject,
  SafeGraphValue,
} from "./safe-graph-copy.js";
import {
  copySafeGraph,
  MAX_SAFE_GRAPH_ARRAY_LENGTH,
  MAX_SAFE_GRAPH_DEPTH,
  MAX_SAFE_GRAPH_PROPERTIES_PER_OBJECT,
  MAX_SAFE_GRAPH_STRING_LENGTH,
} from "./safe-graph-copy.js";
import { MAX_CONFIG_ARRAY_LENGTH } from "./schema-common.js";

const DANGEROUS_RECORD_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const UNSAFE_RECORD_MESSAGE =
  "record input must be an own, enumerable, writable data-property object with safe keys";
const INHERITED_BLOCKER_MESSAGE =
  "schema input contains an inherited property that blocks safe materialization";
const INHERITED_OUTPUT_BLOCKER_MESSAGE =
  "schema output contains an inherited property that blocks safe materialization";
const ZOD_OBJECT_FIELDS_KEY = "shape";

/**
 * Public schema inputs can contain 512 steps, each with two 512-item artifact
 * lists. The graph copier counts an artifact object and its two string values,
 * so the two-list product is the dominant bounded shape. Keep this larger
 * schema-owner budget separate from copySafeGraph's general hostile-input cap.
 */
const MAX_SCHEMA_ARTIFACT_GRAPH_NODES =
  MAX_CONFIG_ARRAY_LENGTH * MAX_CONFIG_ARRAY_LENGTH * 2 * 3;
const MAX_SCHEMA_GRAPH_OVERHEAD = 65_536;
const SCHEMA_INPUT_GRAPH_COPY_BUDGET: SafeGraphCopyBudget = {
  maxDepth: MAX_SAFE_GRAPH_DEPTH,
  maxNodes: MAX_SCHEMA_ARTIFACT_GRAPH_NODES + MAX_SCHEMA_GRAPH_OVERHEAD,
  maxProperties: MAX_SCHEMA_ARTIFACT_GRAPH_NODES + MAX_SCHEMA_GRAPH_OVERHEAD,
  maxPropertiesPerObject: MAX_SAFE_GRAPH_PROPERTIES_PER_OBJECT,
  maxArrayLength: MAX_SAFE_GRAPH_ARRAY_LENGTH,
  maxStringLength: MAX_SAFE_GRAPH_STRING_LENGTH * MAX_CONFIG_ARRAY_LENGTH,
};

type RecordInput<T extends z.ZodType> = {
  readonly [key: string]: z.input<T>;
};

type ParsedRecord<T extends z.ZodType> = {
  [key: string]: z.output<T>;
};

function isRecordInput<T extends z.ZodType, V = unknown>(
  value: V,
): value is V & RecordInput<T> {
  if (value === null || Object(value) !== value || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Build a dynamic record without letting Zod assign through object prototypes. */
export function safeRecordSchema<T extends z.ZodType>(
  valueSchema: T,
): z.ZodType<ParsedRecord<T>, RecordInput<T>>;
export function safeRecordSchema<T extends z.ZodType>(
  valueSchema: T,
): z.ZodType<ParsedRecord<T>, RecordInput<T>> {
  const checkedRecordSchema = z
    .custom<RecordInput<T>>((input) => isRecordInput<T>(input), {
      message: UNSAFE_RECORD_MESSAGE,
    })
    .superRefine((candidate, ctx) => {
      for (const key of Object.keys(candidate)) {
        if (DANGEROUS_RECORD_KEYS.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `record key '${key}' is not allowed`,
          });
          continue;
        }

        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: UNSAFE_RECORD_MESSAGE,
          });
        }
      }
    })
    .transform((candidate) => {
      const entries = new Map<string, z.input<T>>();
      for (const key of Object.keys(candidate)) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor !== undefined && "value" in descriptor) {
          entries.set(key, descriptor.value);
        }
      }
      return entries;
    });

  return checkedRecordSchema.pipe(
    z.map(z.string(), valueSchema).transform((entries) => {
      const record: ParsedRecord<T> = Object.setPrototypeOf({}, null);
      for (const [key, value] of entries) {
        Object.defineProperty(record, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return record;
    }),
  );
}

type ZodObjectDefinition = ConstructorParameters<typeof z.ZodObject>[0];
type Prototype = typeof Object.prototype | typeof Array.prototype;

function isUnsafeInheritedDescriptor(
  descriptor: PropertyDescriptor | undefined,
): boolean {
  if (descriptor === undefined) return false;
  // Accessors can execute arbitrary code. A non-writable data property can
  // swallow or throw the assignment Zod uses to materialize an output object.
  return !("value" in descriptor) || descriptor.writable !== true;
}

function hasPrototypeWriteBlocker(prototype: Prototype, key: string): boolean {
  let current: object | null = prototype;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined)
      return isUnsafeInheritedDescriptor(descriptor);
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function isArrayIndexKey(key: string): boolean {
  const numeric = Number(key);
  return (
    Number.isSafeInteger(numeric) &&
    numeric >= 0 &&
    numeric < 4_294_967_295 &&
    String(numeric) === key
  );
}

function findNumericArrayOutputBlocker(): string | null {
  const keys = new Set<string>();
  let current: object | null = Array.prototype;
  while (current !== null) {
    for (const key of Object.getOwnPropertyNames(current)) keys.add(key);
    current = Object.getPrototypeOf(current);
  }
  for (const key of keys) {
    if (
      isArrayIndexKey(key) &&
      hasPrototypeWriteBlocker(Array.prototype, key)
    ) {
      return key;
    }
  }
  return null;
}

function appendOwn<T>(target: T[], value: T): void {
  Object.defineProperty(target, String(target.length), {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function hasNumericArrayOutputBlocker(): string | null {
  return findNumericArrayOutputBlocker();
}

function isSafeGraphObject(value: SafeGraphValue): value is SafeGraphObject {
  return Object(value) === value && !Array.isArray(value);
}

function hasInheritedInputBlocker(value: SafeGraphValue): boolean {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      if (hasPrototypeWriteBlocker(Array.prototype, key)) return true;
    }
    return false;
  }
  if (!isSafeGraphObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (hasPrototypeWriteBlocker(Object.prototype, key)) return true;
  }
  return false;
}

type AnyZodSchema = z.core.$ZodType;

function findInheritedOutputBlocker(
  schema: AnyZodSchema,
  seen = new Set<AnyZodSchema>(),
): string | null {
  if (seen.has(schema)) return null;
  seen.add(schema);

  if (schema instanceof z.ZodObject) {
    const fields = schema[ZOD_OBJECT_FIELDS_KEY];
    for (const key of Object.keys(fields)) {
      if (hasPrototypeWriteBlocker(Object.prototype, key)) return key;
      const nestedKey = findInheritedOutputBlocker(fields[key], seen);
      if (nestedKey !== null) return nestedKey;
    }
    return null;
  }

  if (schema instanceof z.ZodArray) {
    const numericKey = hasNumericArrayOutputBlocker();
    if (numericKey !== null) return numericKey;
    return findInheritedOutputBlocker(schema.element, seen);
  }
  if (schema instanceof z.ZodDefault) {
    return findInheritedOutputBlocker(schema.unwrap(), seen);
  }
  if (schema instanceof z.ZodOptional) {
    return findInheritedOutputBlocker(schema.unwrap(), seen);
  }
  if (schema instanceof z.ZodNullable) {
    return findInheritedOutputBlocker(schema.unwrap(), seen);
  }
  if (schema instanceof z.ZodCatch) {
    return findInheritedOutputBlocker(schema.unwrap(), seen);
  }
  if (schema instanceof z.ZodPrefault) {
    return findInheritedOutputBlocker(schema.unwrap(), seen);
  }
  if (schema instanceof z.ZodNonOptional) {
    return findInheritedOutputBlocker(schema.unwrap(), seen);
  }
  if (schema instanceof z.ZodReadonly) {
    return findInheritedOutputBlocker(schema.unwrap(), seen);
  }
  if (schema instanceof z.ZodSuccess) {
    return findInheritedOutputBlocker(schema.unwrap(), seen);
  }
  if (schema instanceof z.ZodLazy) {
    return findInheritedOutputBlocker(schema.unwrap(), seen);
  }
  if (schema instanceof z.ZodPipe) {
    const inputKey = findInheritedOutputBlocker(schema.in, seen);
    return inputKey ?? findInheritedOutputBlocker(schema.out, seen);
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      const nestedKey = findInheritedOutputBlocker(option, seen);
      if (nestedKey !== null) return nestedKey;
    }
  }
  if (schema instanceof z.ZodIntersection) {
    const definition = schema._zod.def;
    const leftKey = findInheritedOutputBlocker(definition.left, seen);
    return leftKey ?? findInheritedOutputBlocker(definition.right, seen);
  }
  if (schema instanceof z.ZodTuple) {
    const definition = schema._zod.def;
    for (const item of definition.items) {
      const nestedKey = findInheritedOutputBlocker(item, seen);
      if (nestedKey !== null) return nestedKey;
    }
    if (definition.rest !== null) {
      return findInheritedOutputBlocker(definition.rest, seen);
    }
  }
  if (schema instanceof z.ZodMap) {
    const keyKey = findInheritedOutputBlocker(schema.keyType, seen);
    return keyKey ?? findInheritedOutputBlocker(schema.valueType, seen);
  }
  if (schema instanceof z.ZodSet) {
    return findInheritedOutputBlocker(schema._zod.def.valueType, seen);
  }
  return null;
}

/** Return the first global prototype blocker that can affect this schema. */
export function findSchemaOutputBlocker(schema: z.ZodType): string | null {
  const numericKey = hasNumericArrayOutputBlocker();
  return numericKey ?? findInheritedOutputBlocker(schema);
}

/**
 * Rebuild a Zod object with the same public object interface and a checked
 * input boundary. Zod materializes object results into `{}`; reject an
 * inherited write blocker before that assignment can run.
 */
export function safeObjectSchema<T extends z.ZodObject>(schema: T): T {
  const SafeObject = z.core.$constructor<T, ZodObjectDefinition>(
    "WeaveSafeObject",
    (instance, definition) => {
      z.ZodObject.init(instance, definition);
      instance._zod.deferred ??= [];
      appendOwn(instance._zod.deferred, () => {
        const run = instance._zod.run;
        if (run === undefined) return;
        instance._zod.run = (payload, ctx) => {
          const numericBlocker = hasNumericArrayOutputBlocker();
          if (numericBlocker !== null) {
            appendOwn(payload.issues, {
              code: "custom",
              input: null,
              message: `${INHERITED_OUTPUT_BLOCKER_MESSAGE}: ${numericBlocker}`,
            });
            return payload;
          }
          const copied = copySafeGraph(
            payload.value,
            SCHEMA_INPUT_GRAPH_COPY_BUDGET,
          );
          if (copied.isErr()) {
            appendOwn(payload.issues, {
              code: "custom",
              input: null,
              message: copied.error.message,
            });
            return payload;
          }
          if (hasInheritedInputBlocker(copied.value)) {
            appendOwn(payload.issues, {
              code: "custom",
              input: null,
              message: INHERITED_BLOCKER_MESSAGE,
            });
            return payload;
          }
          const outputBlockerKey = findInheritedOutputBlocker(instance);
          if (outputBlockerKey !== null) {
            appendOwn(payload.issues, {
              code: "custom",
              input: null,
              message: `${INHERITED_OUTPUT_BLOCKER_MESSAGE}: ${outputBlockerKey}`,
            });
            return payload;
          }
          Object.defineProperty(payload, "value", {
            value: copied.value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          return run(payload, ctx);
        };
      });
    },
  );
  return new SafeObject(schema._zod.def);
}

/** Reject unsafe object graphs before a composed Zod schema reads any value. */
export function safeSchemaInput<T extends z.ZodType>(
  schema: T,
): z.ZodType<z.output<T>, z.input<T>>;
export function safeSchemaInput<T extends z.ZodType>(schema: T) {
  return z.preprocess((input, ctx) => {
    const numericBlocker = hasNumericArrayOutputBlocker();
    if (numericBlocker !== null) {
      appendOwn(ctx.issues, {
        code: "custom",
        input: null,
        message: `${INHERITED_OUTPUT_BLOCKER_MESSAGE}: ${numericBlocker}`,
      });
      return z.NEVER;
    }
    const copied = copySafeGraph(input, SCHEMA_INPUT_GRAPH_COPY_BUDGET);
    if (copied.isErr()) {
      appendOwn(ctx.issues, {
        code: "custom",
        input: null,
        message: copied.error.message,
      });
      return z.NEVER;
    }
    const outputBlockerKey = findInheritedOutputBlocker(schema);
    if (outputBlockerKey !== null) {
      appendOwn(ctx.issues, {
        code: "custom",
        input: null,
        message: `${INHERITED_OUTPUT_BLOCKER_MESSAGE}: ${outputBlockerKey}`,
      });
      return z.NEVER;
    }
    return copied.value;
  }, schema);
}
