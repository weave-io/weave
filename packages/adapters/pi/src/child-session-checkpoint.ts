import { err, ok, Result } from "neverthrow";
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
const MAX_JSON_ENTRY_NODES = 262_144;
const MAX_JSON_PROPERTIES = 131_072;
const MAX_JSON_STRING_UNITS = 1_048_576;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;
export const MAX_CHECKPOINT_BYTES = 1_048_576;

const encoder = new TextEncoder();
const unsafeJsonInput = Symbol("unsafe-checkpoint-json-input");

type SnapshotFailure = "unsafe-json";
type JsonObject = { [key: string]: JsonValue };

interface SnapshotBudget {
  nodes: number;
  properties: number;
  stringUnits: number;
}

const JsonObjectSchema = z.record(z.string(), z.json());

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

function isObjectContainer<T>(value: T): value is T & object {
  return Object(value) === value;
}

function newSnapshotBudget(): SnapshotBudget {
  return { nodes: 0, properties: 0, stringUnits: 0 };
}

function snapshotJson<T>(
  value: T,
  budget: SnapshotBudget = newSnapshotBudget(),
  ancestors = new WeakSet<object>(),
  depth = 0,
): Result<JsonValue, SnapshotFailure> {
  if (depth > MAX_JSON_DEPTH || budget.nodes >= MAX_JSON_ENTRY_NODES) {
    return err("unsafe-json");
  }
  budget.nodes += 1;

  if (value === null) return ok(null);
  if (!isObjectContainer(value)) {
    const booleanValue = z.boolean().safeParse(value);
    if (booleanValue.success) return ok(booleanValue.data);
    const numberValue = z.number().finite().safeParse(value);
    if (numberValue.success) return ok(numberValue.data);
    const stringValue = z.string().safeParse(value);
    if (stringValue.success) {
      const bytes = encoder.encode(stringValue.data).byteLength;
      if (
        bytes > MAX_JSON_STRING_BYTES ||
        budget.stringUnits > MAX_JSON_STRING_UNITS - stringValue.data.length
      ) {
        return err("unsafe-json");
      }
      budget.stringUnits += stringValue.data.length;
      return ok(stringValue.data);
    }
    return err("unsafe-json");
  }

  const prototype = Result.fromThrowable(
    () => Object.getPrototypeOf(value),
    (): SnapshotFailure => "unsafe-json",
  )();
  if (prototype.isErr()) return err(prototype.error);

  const arrayResult = Result.fromThrowable(
    () => Array.isArray(value),
    (): SnapshotFailure => "unsafe-json",
  )();
  if (arrayResult.isErr()) return err(arrayResult.error);
  const array = arrayResult.value;
  if (
    (!array &&
      prototype.value !== Object.prototype &&
      prototype.value !== null) ||
    (array && prototype.value !== Array.prototype)
  ) {
    return err("unsafe-json");
  }
  if (ancestors.has(value)) return err("unsafe-json");
  ancestors.add(value);

  const descriptors = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptors(value),
    (): SnapshotFailure => "unsafe-json",
  )();
  if (descriptors.isErr()) return err(descriptors.error);
  const keys = Reflect.ownKeys(descriptors.value);

  if (array) {
    const lengthDescriptor = descriptors.value.length;
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
      return err("unsafe-json");
    }
    const length = z
      .number()
      .int()
      .min(0)
      .max(MAX_JSON_ITEMS)
      .safeParse(lengthDescriptor.value);
    if (!length.success) return err("unsafe-json");
    const indexKeys = keys.filter((key) => key !== "length");
    if (indexKeys.length !== length.data || keys.length !== length.data + 1) {
      return err("unsafe-json");
    }
    const result: JsonValue[] = [];
    for (let index = 0; index < length.data; index += 1) {
      const key = String(index);
      if (!indexKeys.includes(key)) return err("unsafe-json");
      const keyResult = z.string().safeParse(key);
      if (!keyResult.success) return err("unsafe-json");
      const descriptor = descriptors.value[keyResult.data];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return err("unsafe-json");
      }
      if (budget.properties >= MAX_JSON_PROPERTIES) return err("unsafe-json");
      budget.properties += 1;
      const child = snapshotJson(
        descriptor.value,
        budget,
        ancestors,
        depth + 1,
      );
      if (child.isErr()) return err(child.error);
      result.push(child.value);
    }
    ancestors.delete(value);
    return ok(result);
  }

  if (keys.length > MAX_JSON_KEYS) return err("unsafe-json");
  const result: JsonObject = {};
  for (const key of keys) {
    const parsedKey = z.string().safeParse(key);
    if (!parsedKey.success) return err("unsafe-json");
    if (encoder.encode(parsedKey.data).byteLength > MAX_ID_BYTES) {
      return err("unsafe-json");
    }
    const descriptor = descriptors.value[parsedKey.data];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return err("unsafe-json");
    }
    if (budget.properties >= MAX_JSON_PROPERTIES) return err("unsafe-json");
    budget.properties += 1;
    const child = snapshotJson(descriptor.value, budget, ancestors, depth + 1);
    if (child.isErr()) return err(child.error);
    Object.defineProperty(result, parsedKey.data, {
      configurable: true,
      enumerable: true,
      value: child.value,
      writable: true,
    });
  }
  ancestors.delete(value);
  return ok(result);
}

/** Check JSON data without accepting undefined, class instances, cycles, or deep values. */
const boundedJson = z.custom<JsonValue>(
  (value) => snapshotJson(value).isOk(),
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

const CheckpointOwnerSchema = z
  .object({
    schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
    activeLeaf: id.optional(),
    checkpointCursor: cursor,
    entries: z.array(CheckpointEntrySchema).max(MAX_ENTRIES),
    updatedAt: cursor,
  })
  .strict();

export const PiChildSessionCheckpointSchema = z.preprocess(
  (value) => snapshotJson(value).unwrapOr(unsafeJsonInput),
  CheckpointOwnerSchema,
);

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

function safeVersion<T>(value: T): number | undefined {
  const parsed = z.number().int().safeParse(value);
  return parsed.success && Number.isSafeInteger(parsed.data)
    ? parsed.data
    : undefined;
}

function normalizeCheckpointValue(value: JsonValue): JsonValue {
  const record = JsonObjectSchema.safeParse(value);
  if (!record.success || Object.hasOwn(record.data, "checkpointCursor")) {
    return value;
  }
  const entries = z.array(CheckpointEntrySchema).safeParse(record.data.entries);
  if (!entries.success) return value;
  return { ...record.data, checkpointCursor: entries.data.length };
}

function entryBytes(
  entry: PiChildSessionCheckpointEntry,
): Result<Uint8Array, PiChildCheckpointError> {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(entry),
    (): PiChildCheckpointError => ({ type: "checkpoint-json-invalid" }),
  )();
  if (serialized.isErr()) return err(serialized.error);
  if (serialized.value === undefined) {
    return err({ type: "checkpoint-json-invalid" });
  }
  const bytes = encoder.encode(serialized.value);
  return bytes.byteLength > MAX_ENTRY_BYTES
    ? err({ type: "checkpoint-oversized", scope: "entry" })
    : ok(bytes);
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = JsonObjectSchema.safeParse(value);
  if (record.success) {
    return `{${Object.keys(record.data)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record.data[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "" : serialized;
}

function canonicalEntry(entry: PiChildSessionCheckpointEntry): string {
  const fields = [
    `"id":${JSON.stringify(entry.id)}`,
    `"kind":${JSON.stringify(entry.kind)}`,
    `"payload":${canonicalJson(entry.payload)}`,
  ];
  if (entry.cursor !== undefined) {
    fields.push(`"cursor":${entry.cursor}`);
  }
  if (entry.parentId !== undefined) {
    fields.push(`"parentId":${JSON.stringify(entry.parentId)}`);
  }
  fields.sort();
  return `{${fields.join(",")}}`;
}

function sameEntry(
  left: PiChildSessionCheckpointEntry,
  right: PiChildSessionCheckpointEntry,
): boolean {
  return canonicalEntry(left) === canonicalEntry(right);
}

function validateEntries(
  entries: readonly PiChildSessionCheckpointEntry[],
): Result<void, PiChildCheckpointError> {
  const cursors: number[] = [];
  for (const entry of entries) {
    const encoded = entryBytes(entry);
    if (encoded.isErr()) return err(encoded.error);
    if (entry.cursor !== undefined) cursors.push(entry.cursor);
  }
  if (cursors.length !== 0 && cursors.length !== entries.length) {
    return err({ type: "checkpoint-out-of-order" });
  }
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
  return ok();
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
  return ok();
}

function parseCheckpointEntries<T>(
  entries: T,
): Result<readonly PiChildSessionCheckpointEntry[], PiChildCheckpointError> {
  const snapshot = snapshotJson(entries);
  if (snapshot.isErr()) return invalid(["entries"]);
  const parsed = z
    .array(CheckpointEntrySchema)
    .max(MAX_ENTRIES)
    .safeParse(snapshot.value);
  if (!parsed.success) {
    return invalid(parsed.error.issues.map((issue) => issue.path.join(".")));
  }
  const validation = validateEntries(parsed.data);
  return validation.isErr() ? err(validation.error) : ok(parsed.data);
}

export function parsePiChildSessionCheckpoint<T>(
  value: T,
): Result<PiChildSessionCheckpoint, PiChildCheckpointError> {
  const snapshot = snapshotJson(value);
  if (snapshot.isErr()) return invalid(["checkpoint"]);
  const normalized = normalizeCheckpointValue(snapshot.value);
  const record = JsonObjectSchema.safeParse(normalized);
  if (record.success && Object.hasOwn(record.data, "schemaVersion")) {
    const version = safeVersion(record.data.schemaVersion);
    if (version !== undefined && version !== CHECKPOINT_SCHEMA_VERSION) {
      return err({ type: "checkpoint-version-unsupported", version });
    }
    if (version === undefined && record.data.schemaVersion !== 1) {
      return invalid(["schemaVersion"]);
    }
  }

  const parsed = CheckpointOwnerSchema.safeParse(normalized);
  if (!parsed.success) {
    return invalid(parsed.error.issues.map((issue) => issue.path.join(".")));
  }
  const entryValidation = validateEntries(parsed.data.entries);
  if (entryValidation.isErr()) return err(entryValidation.error);
  const ancestry = validateAncestry(parsed.data.entries);
  if (ancestry.isErr()) return err(ancestry.error);
  if (parsed.data.checkpointCursor < parsed.data.entries.length) {
    return err({ type: "checkpoint-out-of-order" });
  }
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
  const byteLength = Result.fromThrowable(
    () => bytes.byteLength,
    (): PiChildCheckpointError => ({ type: "checkpoint-json-invalid" }),
  )();
  if (byteLength.isErr()) return err(byteLength.error);
  if (byteLength.value > MAX_CHECKPOINT_BYTES) {
    return err({ type: "checkpoint-oversized", scope: "checkpoint" });
  }
  const text = Result.fromThrowable(
    () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    (): PiChildCheckpointError => ({ type: "checkpoint-json-invalid" }),
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
    (): PiChildCheckpointError => ({ type: "checkpoint-json-invalid" }),
  )();
  if (serialized.isErr()) return err(serialized.error);
  if (serialized.value === undefined) {
    return err({ type: "checkpoint-json-invalid" });
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
  const incoming = parseCheckpointEntries(entries);
  if (incoming.isErr()) return err(incoming.error);

  const seen = new Map(current.value.entries.map((entry) => [entry.id, entry]));
  const batchIds = new Set<string>();
  const additions: PiChildSessionCheckpointEntry[] = [];
  for (const entry of incoming.value) {
    if (batchIds.has(entry.id)) return err({ type: "checkpoint-duplicate" });
    batchIds.add(entry.id);
    const previous = seen.get(entry.id);
    if (previous !== undefined) {
      if (!sameEntry(previous, entry)) {
        return err({ type: "checkpoint-conflict" });
      }
      continue;
    }
    additions.push(entry);
    seen.set(entry.id, entry);
  }

  const expectedCursor = current.value.checkpointCursor + additions.length;
  const resolvedCursor = nextCursor ?? expectedCursor;
  if (!cursor.safeParse(resolvedCursor).success) {
    return invalid(["checkpointCursor"]);
  }
  if (resolvedCursor < current.value.checkpointCursor) {
    return err({ type: "checkpoint-out-of-order" });
  }
  if (activeLeaf !== undefined && !id.safeParse(activeLeaf).success) {
    return invalid(["activeLeaf"]);
  }

  const nextEntries = [...current.value.entries, ...additions];
  const nextActiveLeaf =
    activeLeaf === undefined ? current.value.activeLeaf : activeLeaf;
  if (
    nextActiveLeaf !== undefined &&
    !nextEntries.some((entry) => entry.id === nextActiveLeaf)
  ) {
    return invalid(["activeLeaf"]);
  }
  const nextCheckpoint = {
    ...current.value,
    entries: nextEntries,
    checkpointCursor: resolvedCursor,
    updatedAt: now,
  };
  if (nextActiveLeaf === undefined) {
    return parsePiChildSessionCheckpoint(nextCheckpoint);
  }
  return parsePiChildSessionCheckpoint({
    ...nextCheckpoint,
    activeLeaf: nextActiveLeaf,
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
