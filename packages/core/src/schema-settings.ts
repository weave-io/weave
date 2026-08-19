import { z } from "zod";
import {
  safeObjectSchema,
  safeRecordSchema,
  safeSchemaInput,
} from "./safe-schema-input.js";
import { DelegationSettingsObjectSchema } from "./schema-agent.js";
import {
  MAX_CONFIG_ARRAY_LENGTH,
  PositiveSafeIntegerSchema,
  recordEntries,
} from "./schema-common.js";

/** Harness-neutral JSON data carried by opaque adapter settings. */
export type JsonValue =
  | null
  | boolean
  | string
  | number
  | JsonValue[]
  | { [key: string]: JsonValue };

const JsonValueRawSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.string(),
    z.number().finite(),
    z.array(JsonValueRawSchema).max(MAX_CONFIG_ARRAY_LENGTH),
    safeRecordSchema(JsonValueRawSchema),
  ]),
);

export const JsonValueSchema = safeSchemaInput(JsonValueRawSchema);

const JsonObjectSchema = safeRecordSchema(JsonValueRawSchema);

const ADAPTER_SETTINGS_MAX_DEPTH = 4;
const ADAPTER_SETTINGS_MAX_BYTES = 64 * 1024;

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = JsonObjectSchema.safeParse(value);
  if (object.success) {
    return `{${Object.keys(object.data)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object.data[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkAdapterValue(
  value: JsonValue,
  path: (string | number)[],
  depth: number,
  ctx: z.RefinementCtx,
): void {
  if (depth > ADAPTER_SETTINGS_MAX_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `adapter setting nesting exceeds maximum depth of ${ADAPTER_SETTINGS_MAX_DEPTH}`,
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      checkAdapterValue(entry, [...path, index], depth + 1, ctx);
    });
    return;
  }
  const object = JsonObjectSchema.safeParse(value);
  if (object.success) {
    Object.entries(object.data).forEach(([key, entry]) => {
      checkAdapterValue(entry, [...path, key], depth + 1, ctx);
    });
  }
}

const AdapterSettingsObjectSchema = safeRecordSchema(
  JsonValueRawSchema,
).superRefine((adapters, ctx) => {
  for (const [harness, value] of recordEntries(adapters)) {
    checkAdapterValue(value, [harness], 0, ctx);
    const bytes = new TextEncoder().encode(canonicalJson(value)).byteLength;
    if (bytes > ADAPTER_SETTINGS_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [harness],
        message: `adapter settings exceed the 64 KiB canonical JSON limit (${bytes} bytes)`,
      });
    }
  }
});

export const AdapterSettingsSchema = safeSchemaInput(
  AdapterSettingsObjectSchema,
);

/** Valid log level values (uppercase bare identifiers in DSL). */
export const LogLevelSchema = z.enum([
  "TRACE",
  "DEBUG",
  "INFO",
  "WARN",
  "ERROR",
  "FATAL",
]);

/** Defaults for Runtime Store journaling and retention. */
export const DEFAULT_RUNTIME_JOURNAL_SETTINGS = {
  strict: false,
  retention_days: 30,
  max_entries: 10_000,
} as const;

export const DEFAULT_RUNTIME_USAGE_SETTINGS = {
  detail_retention_days: 30,
  max_observations: 100_000,
} as const;

export const DEFAULT_RUNTIME_LOG_SETTINGS = {
  max_segment_bytes: 5_242_880,
  max_segments: 3,
} as const;

export const DEFAULT_RUNTIME_SETTINGS = {
  journal: { ...DEFAULT_RUNTIME_JOURNAL_SETTINGS },
  usage: { ...DEFAULT_RUNTIME_USAGE_SETTINGS },
  log: { ...DEFAULT_RUNTIME_LOG_SETTINGS },
} as const;

/** Runtime journal retention + strictness. Bounds: days 1..3650, entries 1..10_000_000. */
const RuntimeJournalSettingsObjectSchema = safeObjectSchema(
  z.object({
    strict: z.boolean().default(DEFAULT_RUNTIME_JOURNAL_SETTINGS.strict),
    retention_days: PositiveSafeIntegerSchema.max(3650).default(
      DEFAULT_RUNTIME_JOURNAL_SETTINGS.retention_days,
    ),
    max_entries: PositiveSafeIntegerSchema.max(10_000_000).default(
      DEFAULT_RUNTIME_JOURNAL_SETTINGS.max_entries,
    ),
  }),
).default({ ...DEFAULT_RUNTIME_JOURNAL_SETTINGS });

/** Usage-detail retention. Bounds: days 1..3650, observations 1..10_000_000. */
const RuntimeUsageSettingsObjectSchema = safeObjectSchema(
  z.object({
    detail_retention_days: PositiveSafeIntegerSchema.max(3650).default(
      DEFAULT_RUNTIME_USAGE_SETTINGS.detail_retention_days,
    ),
    max_observations: PositiveSafeIntegerSchema.max(10_000_000).default(
      DEFAULT_RUNTIME_USAGE_SETTINGS.max_observations,
    ),
  }),
).default({ ...DEFAULT_RUNTIME_USAGE_SETTINGS });

/**
 * Rotating log segment bounds.
 * `max_segment_bytes` 65_536..1_073_741_824; `max_segments` 1..100.
 */
const RuntimeLogSettingsObjectSchema = safeObjectSchema(
  z.object({
    max_segment_bytes: z
      .number()
      .int()
      .min(65_536)
      .max(1_073_741_824)
      .default(DEFAULT_RUNTIME_LOG_SETTINGS.max_segment_bytes),
    max_segments: PositiveSafeIntegerSchema.max(100).default(
      DEFAULT_RUNTIME_LOG_SETTINGS.max_segments,
    ),
  }),
).default({ ...DEFAULT_RUNTIME_LOG_SETTINGS });

/** Runtime-specific settings nested inside `settings { runtime { ... } }`. */
const RuntimeSettingsObjectSchema = safeObjectSchema(
  z.object({
    journal: RuntimeJournalSettingsObjectSchema,
    usage: RuntimeUsageSettingsObjectSchema,
    log: RuntimeLogSettingsObjectSchema,
  }),
).default({ ...DEFAULT_RUNTIME_SETTINGS });

export const RuntimeJournalSettingsSchema = safeSchemaInput(
  RuntimeJournalSettingsObjectSchema,
);
export const RuntimeUsageSettingsSchema = safeSchemaInput(
  RuntimeUsageSettingsObjectSchema,
);
export const RuntimeLogSettingsSchema = safeSchemaInput(
  RuntimeLogSettingsObjectSchema,
);
export const RuntimeSettingsSchema = safeSchemaInput(
  RuntimeSettingsObjectSchema,
);

/**
 * The `settings { ... }` block — canonical home for log level and runtime
 * configuration. Top-level `log_level` is rejected; use `settings { log_level INFO }`.
 */
export const SettingsConfigObjectSchema = safeObjectSchema(
  z.object({
    log_level: LogLevelSchema.default("INFO"),
    delegation: DelegationSettingsObjectSchema.optional(),
    runtime: RuntimeSettingsObjectSchema,
    // Resolve the semantic default after layered config merge. Keeping this
    // optional preserves whether a higher-priority scope omitted the field.
    enforce_permissions: z.boolean().optional(),
    adapters: AdapterSettingsObjectSchema.optional(),
  }),
).default({
  log_level: "INFO",
  runtime: { ...DEFAULT_RUNTIME_SETTINGS },
});

export const SettingsConfigSchema = safeSchemaInput(SettingsConfigObjectSchema);

export type LogLevel = z.infer<typeof LogLevelSchema>;
export type RuntimeJournalSettings = z.infer<
  typeof RuntimeJournalSettingsSchema
>;
export type RuntimeUsageSettings = z.infer<typeof RuntimeUsageSettingsSchema>;
export type RuntimeLogSettings = z.infer<typeof RuntimeLogSettingsSchema>;
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
export type JsonAdapterSettings = z.infer<typeof AdapterSettingsSchema>;
export type SettingsConfig = z.infer<typeof SettingsConfigSchema>;
