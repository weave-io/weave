import { err, ok, Result, type Result as ResultType } from "neverthrow";
import { z } from "zod";
import { type JsonValue, parseStrictJson } from "./strict-json.js";

const CHECKPOINT_SCHEMA_VERSION = 1 as const;
const MAX_ENTRIES = 16_384;
const MAX_ID_BYTES = 256;
const MAX_KIND_BYTES = 128;
const MAX_JSON_STRING_BYTES = 16_384;
const MAX_JSON_KEYS = 64;
const MAX_JSON_ITEMS = 128;
const MAX_JSON_DEPTH = 32;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;
export const MAX_CHECKPOINT_BYTES = 1_048_576;

const encoder = new TextEncoder();

const boundedString = (maxBytes: number, maxCharacters = maxBytes) =>
  z
    .string()
    .max(maxCharacters)
    .refine(
      (value) => encoder.encode(value).byteLength <= maxBytes,
      `string exceeds ${maxBytes} UTF-8 bytes`,
    );

const id = boundedString(MAX_ID_BYTES).min(1);
const cursor = z.number().int().min(0).max(MAX_CURSOR).finite();

/** Check JSON data without accepting undefined, class instances, cycles, or deep values. */
function isBoundedJson(
  value: unknown,
  depth = 0,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string")
    return encoder.encode(value).byteLength <= MAX_JSON_STRING_BYTES;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null &&
    !Array.isArray(value)
  ) {
    return false;
  }
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    valid = value.length <= MAX_JSON_ITEMS;
    for (const item of value) {
      if (!isBoundedJson(item, depth + 1, ancestors)) {
        valid = false;
        break;
      }
    }
  } else {
    const entries = Object.entries(value);
    valid =
      entries.length <= MAX_JSON_KEYS &&
      entries.every(
        ([key, item]) =>
          encoder.encode(key).byteLength <= MAX_ID_BYTES &&
          isBoundedJson(item, depth + 1, ancestors),
      );
  }
  ancestors.delete(value);
  return valid;
}

const boundedJson = z.custom<JsonValue>(
  (value) => isBoundedJson(value),
  "payload contains unsupported or oversized JSON data",
);

const CheckpointEntrySchema = z
  .object({
    id,
    parentId: id.optional(),
    kind: boundedString(MAX_KIND_BYTES).min(1),
    payload: boundedJson,
    /** Optional source cursor retained with the entry when supplied by the RPC. */
    cursor: cursor.optional(),
  })
  .strict();

export const PiChildSessionCheckpointSchema = z
  .object({
    schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
    activeLeaf: id.optional(),
    checkpointCursor: cursor,
    entries: z.array(CheckpointEntrySchema).max(MAX_ENTRIES),
    updatedAt: cursor,
  })
  .strict();

export type PiChildSessionCheckpoint = z.infer<
  typeof PiChildSessionCheckpointSchema
>;
export type PiChildSessionCheckpointEntry = z.infer<
  typeof CheckpointEntrySchema
>;

export type PiChildCheckpointError =
  | { readonly type: "checkpoint-invalid"; readonly issues: readonly string[] }
  | { readonly type: "checkpoint-json-invalid" }
  | {
      readonly type: "checkpoint-oversized";
      readonly scope: "entry" | "checkpoint";
    }
  | { readonly type: "checkpoint-duplicate" }
  | { readonly type: "checkpoint-conflict" }
  | { readonly type: "checkpoint-out-of-order" }
  | {
      readonly type: "checkpoint-version-unsupported";
      readonly version: number;
    };

function invalid(
  issues: readonly string[],
): Result<never, PiChildCheckpointError> {
  return err({ type: "checkpoint-invalid", issues });
}

function safeVersion(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCheckpointValue(value: unknown): unknown {
  if (!isRecord(value) || Object.hasOwn(value, "checkpointCursor"))
    return value;
  if (!Array.isArray(value.entries)) return value;
  return { ...value, checkpointCursor: value.entries.length };
}

function entryBytes(
  entry: PiChildSessionCheckpointEntry,
): ResultType<Uint8Array, PiChildCheckpointError> {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(entry),
    () => ({ type: "checkpoint-json-invalid" }) as const,
  )();
  if (serialized.isErr() || serialized.value === undefined) {
    return err(
      serialized.isErr()
        ? serialized.error
        : { type: "checkpoint-json-invalid" },
    );
  }
  const bytes = encoder.encode(serialized.value);
  return bytes.byteLength > MAX_ENTRY_BYTES
    ? err({ type: "checkpoint-oversized", scope: "entry" })
    : ok(bytes);
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function sameEntry(
  left: PiChildSessionCheckpointEntry,
  right: PiChildSessionCheckpointEntry,
): boolean {
  return (
    canonical(left as unknown as JsonValue) ===
    canonical(right as unknown as JsonValue)
  );
}

function validateEntries(
  entries: readonly PiChildSessionCheckpointEntry[],
): Result<void, PiChildCheckpointError> {
  const cursors: number[] = [];
  for (const entry of entries) {
    const parsed = CheckpointEntrySchema.safeParse(entry);
    if (!parsed.success)
      return invalid(parsed.error.issues.map((issue) => issue.path.join(".")));
    const encoded = entryBytes(parsed.data);
    if (encoded.isErr()) return err(encoded.error);
    if (parsed.data.cursor !== undefined) cursors.push(parsed.data.cursor);
  }
  if (cursors.length !== 0 && cursors.length !== entries.length)
    return err({ type: "checkpoint-out-of-order" });
  for (let index = 1; index < cursors.length; index += 1) {
    const previous = cursors[index - 1];
    const current = cursors[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current <= previous
    ) {
      return err({ type: "checkpoint-out-of-order" });
    }
  }
  return ok(undefined);
}

function validateAncestry(
  entries: readonly PiChildSessionCheckpointEntry[],
): Result<void, PiChildCheckpointError> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) return err({ type: "checkpoint-duplicate" });
    if (entry.parentId !== undefined && !ids.has(entry.parentId)) {
      return err({ type: "checkpoint-out-of-order" });
    }
    ids.add(entry.id);
  }
  return ok(undefined);
}

export function parsePiChildSessionCheckpoint(
  value: unknown,
): Result<PiChildSessionCheckpoint, PiChildCheckpointError> {
  if (
    isRecord(value) &&
    Object.hasOwn(value, "schemaVersion") &&
    value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION
  ) {
    const version = safeVersion(value.schemaVersion);
    if (version !== undefined)
      return err({ type: "checkpoint-version-unsupported", version });
    return invalid(["schemaVersion"]);
  }

  const parsed = PiChildSessionCheckpointSchema.safeParse(
    normalizeCheckpointValue(value),
  );
  if (!parsed.success)
    return invalid(parsed.error.issues.map((issue) => issue.path.join(".")));
  const entryValidation = validateEntries(parsed.data.entries);
  if (entryValidation.isErr()) return err(entryValidation.error);
  const ancestry = validateAncestry(parsed.data.entries);
  if (ancestry.isErr()) return err(ancestry.error);
  if (parsed.data.checkpointCursor < parsed.data.entries.length)
    return err({ type: "checkpoint-out-of-order" });
  if (
    parsed.data.activeLeaf !== undefined &&
    !new Set(parsed.data.entries.map((entry) => entry.id)).has(
      parsed.data.activeLeaf,
    )
  ) {
    return invalid(["activeLeaf"]);
  }
  return ok(parsed.data);
}

export function decodePiChildSessionCheckpoint(
  bytes: Uint8Array,
): Result<PiChildSessionCheckpoint, PiChildCheckpointError> {
  if (bytes.byteLength > MAX_CHECKPOINT_BYTES)
    return err({ type: "checkpoint-oversized", scope: "checkpoint" });
  const text = Result.fromThrowable(
    () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    () => ({ type: "checkpoint-json-invalid" }) as const,
  )();
  if (text.isErr()) return err(text.error);
  const value = parseStrictJson(text.value);
  if (value.isErr()) return err({ type: "checkpoint-json-invalid" });
  return parsePiChildSessionCheckpoint(value.value);
}

export function encodePiChildSessionCheckpoint(
  value: PiChildSessionCheckpoint,
): Result<Uint8Array, PiChildCheckpointError> {
  const parsed = parsePiChildSessionCheckpoint(value);
  if (parsed.isErr()) return err(parsed.error);
  const serialized = Result.fromThrowable(
    () => JSON.stringify(parsed.value),
    () => ({ type: "checkpoint-json-invalid" }) as const,
  )();
  if (serialized.isErr() || serialized.value === undefined) {
    return err(
      serialized.isErr()
        ? serialized.error
        : { type: "checkpoint-json-invalid" },
    );
  }
  const bytes = encoder.encode(serialized.value);
  return bytes.byteLength > MAX_CHECKPOINT_BYTES
    ? err({ type: "checkpoint-oversized", scope: "checkpoint" })
    : ok(bytes);
}

/** Merge by stable identity while preserving every complete branch. */
export function appendUnseenCheckpointEntries(
  checkpoint: PiChildSessionCheckpoint,
  entries: readonly PiChildSessionCheckpointEntry[],
  activeLeaf: string | undefined,
  now: number,
  nextCursor?: number,
): Result<PiChildSessionCheckpoint, PiChildCheckpointError> {
  const current = parsePiChildSessionCheckpoint(checkpoint);
  if (current.isErr()) return err(current.error);
  if (!cursor.safeParse(now).success) return invalid(["updatedAt"]);
  const incoming = validateEntries(entries);
  if (incoming.isErr()) return err(incoming.error);

  const seen = new Map(current.value.entries.map((entry) => [entry.id, entry]));
  const batchIds = new Set<string>();
  const additions: PiChildSessionCheckpointEntry[] = [];
  for (const entry of entries) {
    if (batchIds.has(entry.id)) return err({ type: "checkpoint-duplicate" });
    batchIds.add(entry.id);
    const previous = seen.get(entry.id);
    if (previous !== undefined) {
      if (!sameEntry(previous, entry))
        return err({ type: "checkpoint-conflict" });
      continue;
    }
    additions.push(entry);
    seen.set(entry.id, entry);
  }

  const expectedCursor = current.value.checkpointCursor + additions.length;
  const resolvedCursor = nextCursor ?? expectedCursor;
  if (!cursor.safeParse(resolvedCursor).success)
    return invalid(["checkpointCursor"]);
  if (resolvedCursor < current.value.checkpointCursor) {
    return err({ type: "checkpoint-out-of-order" });
  }
  if (activeLeaf !== undefined && !id.safeParse(activeLeaf).success)
    return invalid(["activeLeaf"]);

  const nextEntries = [...current.value.entries, ...additions];
  const nextActiveLeaf =
    activeLeaf === undefined ? current.value.activeLeaf : activeLeaf;
  if (
    nextActiveLeaf !== undefined &&
    !nextEntries.some((entry) => entry.id === nextActiveLeaf)
  ) {
    return invalid(["activeLeaf"]);
  }
  return parsePiChildSessionCheckpoint({
    ...current.value,
    entries: nextEntries,
    checkpointCursor: resolvedCursor,
    ...(nextActiveLeaf === undefined
      ? { activeLeaf: undefined }
      : { activeLeaf: nextActiveLeaf }),
    updatedAt: now,
  });
}

export function createEmptyPiChildSessionCheckpoint(
  now: number,
): PiChildSessionCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    checkpointCursor: 0,
    entries: [],
    updatedAt: now,
  };
}
