import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export const PI_CHILD_HISTORY_SCHEMA_VERSION = 1 as const;
export const MAX_HISTORY_STRING = 4_096;
export const MAX_FINAL_OUTPUT_BYTES = 4_096;
export const MAX_BRANCH_ANCESTRY = 64;
export const MAX_HISTORY_NUMBER = Number.MAX_SAFE_INTEGER;

const utf8BoundedString = (maxBytes: number, maxCharacters = maxBytes) =>
  z
    .string()
    .max(maxCharacters)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
      `string exceeds ${maxBytes} UTF-8 bytes`,
    );
const text = utf8BoundedString(MAX_HISTORY_STRING);
const finalOutput = utf8BoundedString(MAX_FINAL_OUTPUT_BYTES);
const id = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 256,
    "id exceeds 256 UTF-8 bytes",
  );
const nonNegative = z.number().int().min(0).max(MAX_HISTORY_NUMBER).finite();
const timestamp = nonNegative;

export const PiChildHistoryKindSchema = z.enum([
  "ordinary",
  "nested",
  "workflow-step",
]);
export type PiChildHistoryKind = z.infer<typeof PiChildHistoryKindSchema>;

export const PiChildHistoryStatusSchema = z.enum([
  "running",
  "queued",
  "settled",
  "interrupted",
  "quarantined",
  "cleared",
]);
export type PiChildHistoryStatus = z.infer<typeof PiChildHistoryStatusSchema>;

const BreadcrumbSchema = z
  .object({
    workflow: text.optional(),
    step: text.optional(),
  })
  .strict();

const BranchSchema = z
  .object({
    childId: id,
    parentChildId: id.optional(),
    checkpoint: nonNegative,
  })
  .strict();

const TrimMetadataSchema = z
  .object({
    trimmed: z.boolean(),
    markerCount: nonNegative,
    lastTrimmedAt: timestamp.optional(),
  })
  .strict();

const QuarantineMetadataSchema = z
  .object({
    quarantined: z.boolean(),
    reasonClass: text.optional(),
    quarantinedAt: timestamp.optional(),
    byteCount: nonNegative.optional(),
  })
  .strict();

const ClearMetadataSchema = z
  .object({
    cleared: z.boolean(),
    clearedAt: timestamp.optional(),
  })
  .strict();

const RecoveryMetadataSchema = z
  .object({
    eligible: z.boolean(),
    count: nonNegative,
    lastRecoveredAt: timestamp.optional(),
  })
  .strict();

const SAFE_SESSION_PATH_COMPONENT = /^[A-Za-z0-9._-]+$/;

function isSafeRelativeSessionPath(value: string): boolean {
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }

  return value.split("/").every(
    (component) =>
      component.length > 0 &&
      component !== "." &&
      component !== ".." &&
      SAFE_SESSION_PATH_COMPONENT.test(component),
  );
}

/** Export/index-facing metadata. It deliberately has no transcript fields. */
export const PiChildHistoryRecordSchema = z
  .object({
    childId: id,
    parentSessionId: id,
    parentChildId: id.optional(),
    kind: PiChildHistoryKindSchema,
    status: PiChildHistoryStatusSchema,
    workflow: BreadcrumbSchema,
    sessionPath: utf8BoundedString(1_024).pipe(
      z
        .string()
        .min(1)
        .refine(
          isSafeRelativeSessionPath,
          "sessionPath must be a safe relative path",
        ),
    ),
    activeLeaf: id.optional(),
    checkpointCursor: nonNegative,
    branchAncestry: z.array(BranchSchema).max(MAX_BRANCH_ANCESTRY),
    interventionCount: nonNegative,
    /** The only transcript-derived field allowed in an exported index. */
    finalOutput,
    trim: TrimMetadataSchema,
    quarantine: QuarantineMetadataSchema,
    clear: ClearMetadataSchema,
    recovery: RecoveryMetadataSchema,
    bytes: z
      .object({
        session: nonNegative,
        checkpoint: nonNegative,
        total: nonNegative,
      })
      .strict(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type PiChildHistoryRecord = z.infer<typeof PiChildHistoryRecordSchema>;

export const PiChildHistoryIndexV1Schema = z
  .object({
    schemaVersion: z.literal(PI_CHILD_HISTORY_SCHEMA_VERSION),
    parentSessionId: id,
    records: z.array(PiChildHistoryRecordSchema).max(1_024),
    updatedAt: timestamp,
  })
  .strict();
export type PiChildHistoryIndexV1 = z.infer<typeof PiChildHistoryIndexV1Schema>;

export const PiChildHistoryLayoutSchema = z
  .object({
    indexFile: z.literal("index.v1.json"),
    childDirectory: z
      .string()
      .regex(/^[^/\\.][^/\\]*$/)
      .max(256),
    sessionFile: z
      .string()
      .regex(/^[^/\\]+$/)
      .max(256),
    checkpointFile: z
      .string()
      .regex(/^[^/\\]+$/)
      .max(256),
    directoryMode: z.literal(0o700),
    fileMode: z.literal(0o600),
  })
  .strict();
export type PiChildHistoryLayout = z.infer<typeof PiChildHistoryLayoutSchema>;

export type PiChildHistorySchemaError =
  | {
      readonly type: "ChildHistorySchemaInvalid";
      readonly issues: readonly string[];
    }
  | {
      readonly type: "ChildHistoryVersionUnsupported";
      readonly version: number | string;
    };

export function parsePiChildHistoryIndex(
  value: unknown,
): Result<PiChildHistoryIndexV1, PiChildHistorySchemaError> {
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    (typeof value.schemaVersion === "number" ||
      typeof value.schemaVersion === "string") &&
    value.schemaVersion !== PI_CHILD_HISTORY_SCHEMA_VERSION
  ) {
    return err({
      type: "ChildHistoryVersionUnsupported",
      version: value.schemaVersion,
    });
  }
  const parsed = PiChildHistoryIndexV1Schema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  return err({
    type: "ChildHistorySchemaInvalid",
    issues: parsed.error.issues.map((issue) => issue.path.join(".")),
  });
}

export type PiChildHistoryMigrationOutcome =
  | { readonly kind: "missing" }
  | { readonly kind: "migrate-v0"; readonly index: PiChildHistoryIndexV1 }
  | { readonly kind: "use-v1"; readonly index: PiChildHistoryIndexV1 }
  | {
      readonly kind: "quarantine";
      readonly safeChildId: string;
      readonly errorClass: string;
    };

export const PI_CHILD_HISTORY_LAYOUT: PiChildHistoryLayout = {
  indexFile: "index.v1.json",
  childDirectory: "children",
  sessionFile: "session.jsonl",
  checkpointFile: "checkpoint.json",
  directoryMode: 0o700,
  fileMode: 0o600,
};
