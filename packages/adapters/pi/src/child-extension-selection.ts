/**
 * Pi child-extension selection record (Pi adapter contract).
 *
 * The engine stores this record as an opaque JSON string under one adapter
 * preference row. Every field name, bound, default, and migration rule below
 * belongs to the Pi adapter: the engine never interprets the payload.
 *
 * This module is pure. It performs no I/O, calls no host API, reads no
 * environment, and never throws on an expected path. Untrusted stored text is
 * decoded with `safeParse`, and a record that cannot be trusted degrades to
 * today's behavior (`inherit-all`) with a bounded diagnostic instead of
 * failing a child spawn.
 *
 * Diagnostics may carry entry ids, and a non-package entry id is an absolute
 * path. Callers that log must report counts and reasons, not ids.
 */
import { isAbsolute } from "node:path";
import { ADAPTER_PREFERENCE_VALUE_MAX_BYTES } from "@weaveio/weave-engine";
import { err, ok, Result } from "neverthrow";
import { z } from "zod";

/** Adapter preference namespace owned by the Pi adapter. */
export const PI_PREFERENCE_NAMESPACE = "adapter-pi";

/** Preference key holding the child-extension selection record. */
export const CHILD_EXTENSION_SELECTION_KEY = "child-extensions";

/** The only record layout this adapter understands. */
export const CHILD_EXTENSION_SELECTION_SCHEMA_VERSION = 1;

/** Upper bound on persisted optional entries. Weave is never among them. */
export const MAX_CHILD_EXTENSION_ENTRIES = 64;

/** Per-field bound, measured in UTF-8 bytes rather than UTF-16 code units. */
export const MAX_CHILD_EXTENSION_FIELD_BYTES = 512;

/** Bound on the free-text part of a decode or encode diagnostic. */
export const MAX_CHILD_EXTENSION_DIAGNOSTIC_DETAIL = 160;

/**
 * Serialized-value bound. Re-exported from the engine so the codec rejects a
 * record the preference repository would reject anyway: 64 entries at the
 * per-field bound would serialize far beyond it.
 */
export const MAX_CHILD_EXTENSION_SELECTION_VALUE_BYTES =
  ADAPTER_PREFERENCE_VALUE_MAX_BYTES;

const encoder = new TextEncoder();

// Built from a named source rather than an inline literal: a regex literal
// here would carry control characters, which the repo lint forbids.
const CONTROL_CHARACTER_SOURCE = String.raw`[\u0000-\u001f\u007f]`;
const CONTROL_CHARACTER_PATTERN = new RegExp(CONTROL_CHARACTER_SOURCE);

function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** True when the value contains a C0 control character, NUL, or DEL. */
function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

function boundDetail(value: string): string {
  return value.length <= MAX_CHILD_EXTENSION_DIAGNOSTIC_DETAIL
    ? value
    : `${value.slice(0, MAX_CHILD_EXTENSION_DIAGNOSTIC_DETAIL - 1)}…`;
}

/**
 * Accepts only a bounded, absolute, traversal-free path with no NUL, no other
 * control character, and no backslash. Matches `validateAbsoluteSpawnPath` in
 * `rpc-child.ts` — a stored path that would be rejected at spawn time must be
 * rejected here first.
 */
export function isSafeChildExtensionPath(value: string): boolean {
  if (value.length === 0) return false;
  if (utf8ByteLength(value) > MAX_CHILD_EXTENSION_FIELD_BYTES) return false;
  if (hasControlCharacter(value)) return false;
  if (value.includes("\\")) return false;
  if (!isAbsolute(value)) return false;
  const components = value.split("/");
  return !components.some(
    (component, index) =>
      index > 0 && (component === "." || component === ".."),
  );
}

/**
 * A displayed or compared text field: non-empty, control-free, and bounded by
 * UTF-8 bytes so a multibyte label cannot exceed the storage budget.
 */
const boundedTextField = z
  .string()
  .min(1)
  .refine((value) => !hasControlCharacter(value), "control character")
  .refine(
    (value) => utf8ByteLength(value) <= MAX_CHILD_EXTENSION_FIELD_BYTES,
    "field exceeds its UTF-8 byte bound",
  );

/**
 * One persisted optional extension.
 *
 * `path` is a hint recorded at save time. Resolution always prefers the live
 * inventory path for the same `id`, so a moved-but-still-configured package
 * keeps working and a stale path can never be handed to a child.
 */
export const ChildExtensionSelectionEntrySchema = z.strictObject({
  id: boundedTextField,
  source: boundedTextField,
  path: z.string().refine(isSafeChildExtensionPath, "unsafe extension path"),
  label: boundedTextField,
});

/** Closed set of selection modes. */
export const CHILD_EXTENSION_SELECTION_MODES = [
  "inherit-all",
  "explicit",
] as const;

export type ChildExtensionSelectionMode =
  (typeof CHILD_EXTENSION_SELECTION_MODES)[number];

/**
 * The stored record.
 *
 * `.strictObject` rejects unknown keys, and `schemaVersion` is a literal, so a
 * future layout is refused rather than half-read.
 */
export const ChildExtensionSelectionRecordSchema = z.strictObject({
  schemaVersion: z.literal(CHILD_EXTENSION_SELECTION_SCHEMA_VERSION),
  mode: z.enum(CHILD_EXTENSION_SELECTION_MODES),
  entries: z
    .array(ChildExtensionSelectionEntrySchema)
    .max(MAX_CHILD_EXTENSION_ENTRIES),
});

export type ChildExtensionSelectionEntry = z.infer<
  typeof ChildExtensionSelectionEntrySchema
>;

export type ChildExtensionSelectionRecord = z.infer<
  typeof ChildExtensionSelectionRecordSchema
>;

/**
 * The default when nothing is stored: inherit every extension the host would
 * give a child, which reproduces today's argv byte for byte.
 */
const NO_ENTRIES: ChildExtensionSelectionEntry[] = [];
Object.freeze(NO_ENTRIES);

export const DEFAULT_CHILD_EXTENSION_SELECTION: ChildExtensionSelectionRecord =
  Object.freeze({
    schemaVersion: CHILD_EXTENSION_SELECTION_SCHEMA_VERSION,
    mode: "inherit-all",
    entries: NO_ENTRIES,
  });

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Structural view of Pi's `sourceInfo`; `PiSourceInfo` is assignable to it. */
export interface ChildExtensionIdentitySource {
  readonly origin: string;
  readonly source: string;
  readonly path: string;
}

export type ChildExtensionIdentityError =
  | { readonly reason: "package-source-unusable" }
  | { readonly reason: "path-unsafe" };

/**
 * Identity rule: a package-origin extension is identified by its configured
 * source (for example `npm:pi-vim`), because its installed path moves between
 * installs. Anything else is identified by its absolute resolved path.
 */
export function childExtensionEntryId(
  info: ChildExtensionIdentitySource,
): Result<string, ChildExtensionIdentityError> {
  if (info.origin === "package") {
    const source = info.source;
    if (
      source.length === 0 ||
      hasControlCharacter(source) ||
      utf8ByteLength(source) > MAX_CHILD_EXTENSION_FIELD_BYTES
    ) {
      return err({ reason: "package-source-unusable" });
    }
    return ok(source);
  }
  if (!isSafeChildExtensionPath(info.path)) {
    return err({ reason: "path-unsafe" });
  }
  return ok(info.path);
}

// ---------------------------------------------------------------------------
// Storage codec
// ---------------------------------------------------------------------------

export type ChildExtensionSelectionDecodeReason =
  | "invalid-json"
  | "unsupported-schema-version"
  | "invalid-record"
  | "value-too-large";

export interface ChildExtensionSelectionDecodeDiagnostic {
  readonly reason: ChildExtensionSelectionDecodeReason;
  /** Bounded, value-free explanation — field paths and codes only. */
  readonly detail: string;
}

export interface DecodedChildExtensionSelection {
  /** Always usable: the default record when the stored text is not trusted. */
  readonly record: ChildExtensionSelectionRecord;
  /** Present only when stored text existed and could not be used. */
  readonly diagnostic?: ChildExtensionSelectionDecodeDiagnostic;
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  const first = issues[0];
  if (first === undefined) return "invalid";
  const path = first.path.map((segment) => String(segment)).join(".");
  return boundDetail(path.length === 0 ? first.code : `${path}: ${first.code}`);
}

/**
 * Reads a stored `schemaVersion` without trusting the prototype chain, so a
 * payload carrying `__proto__` cannot fake a supported version.
 */
function readStoredSchemaVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  if (!Object.hasOwn(value, "schemaVersion")) return undefined;
  return (value as Record<string, unknown>).schemaVersion;
}

/**
 * Decodes the opaque preference value.
 *
 * Absent, malformed, oversized, or unknown-version text all resolve to the
 * `inherit-all` default. Only the stored-text cases carry a diagnostic, so an
 * absent record is distinguishable from a rejected one.
 */
export function decodeChildExtensionSelection(
  valueJson: string | null | undefined,
): DecodedChildExtensionSelection {
  if (valueJson === undefined || valueJson === null || valueJson.length === 0) {
    return { record: DEFAULT_CHILD_EXTENSION_SELECTION };
  }
  const byteLength = utf8ByteLength(valueJson);
  if (byteLength > MAX_CHILD_EXTENSION_SELECTION_VALUE_BYTES) {
    return {
      record: DEFAULT_CHILD_EXTENSION_SELECTION,
      diagnostic: {
        reason: "value-too-large",
        detail: `${byteLength} bytes`,
      },
    };
  }
  const parsedJson = Result.fromThrowable(
    () => JSON.parse(valueJson) as unknown,
    () => undefined,
  )();
  if (parsedJson.isErr()) {
    return {
      record: DEFAULT_CHILD_EXTENSION_SELECTION,
      diagnostic: { reason: "invalid-json", detail: "not valid JSON" },
    };
  }
  const parsed = ChildExtensionSelectionRecordSchema.safeParse(
    parsedJson.value,
  );
  if (parsed.success) return { record: parsed.data };

  const storedVersion = readStoredSchemaVersion(parsedJson.value);
  if (
    storedVersion !== undefined &&
    storedVersion !== CHILD_EXTENSION_SELECTION_SCHEMA_VERSION
  ) {
    return {
      record: DEFAULT_CHILD_EXTENSION_SELECTION,
      diagnostic: {
        reason: "unsupported-schema-version",
        detail: boundDetail(
          typeof storedVersion === "number" || typeof storedVersion === "string"
            ? `schemaVersion ${String(storedVersion)}`
            : `schemaVersion ${typeof storedVersion}`,
        ),
      },
    };
  }
  return {
    record: DEFAULT_CHILD_EXTENSION_SELECTION,
    diagnostic: {
      reason: "invalid-record",
      detail: describeIssues(parsed.error.issues),
    },
  };
}

export type ChildExtensionSelectionEncodeError =
  | { readonly reason: "invalid-record"; readonly detail: string }
  | { readonly reason: "value-too-large"; readonly byteLength: number };

/**
 * Validates a record and renders the opaque JSON string the engine stores.
 *
 * The caller's record is parsed rather than trusted, so a value assembled from
 * host input cannot bypass the bounds on its way into the store.
 */
export function encodeChildExtensionSelection(
  record: unknown,
): Result<string, ChildExtensionSelectionEncodeError> {
  const parsed = ChildExtensionSelectionRecordSchema.safeParse(record);
  if (!parsed.success) {
    return err({
      reason: "invalid-record",
      detail: describeIssues(parsed.error.issues),
    });
  }
  // Validated output is plain JSON data: no cycles, no BigInt, no functions.
  const valueJson = JSON.stringify(parsed.data);
  const byteLength = utf8ByteLength(valueJson);
  if (byteLength > MAX_CHILD_EXTENSION_SELECTION_VALUE_BYTES) {
    return err({ reason: "value-too-large", byteLength });
  }
  return ok(valueJson);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Minimal live-inventory shape this module needs. Task 10's richer entry is
 * structurally assignable to it.
 */
export interface ChildExtensionInventoryEntry {
  readonly id: string;
  readonly path: string;
  /** Absent means available; only an explicit `false` drops the entry. */
  readonly available?: boolean;
}

/** The mandatory Weave entry, derived at resolve time and never persisted. */
export interface ChildExtensionWeaveEntry {
  readonly id: string;
  readonly path: string;
}

export interface ChildExtensionPlanInput {
  /** The decoded record, or `undefined` when nothing usable was stored. */
  readonly record?: ChildExtensionSelectionRecord | undefined;
  readonly inventory: readonly ChildExtensionInventoryEntry[];
  readonly weaveEntry: ChildExtensionWeaveEntry;
}

export type ChildExtensionDropCause = "missing" | "unavailable" | "path-unsafe";

export type ChildExtensionPlanDiagnostic =
  | { readonly reason: "weave-entry-unusable" }
  | {
      readonly reason: "entry-dropped";
      readonly id: string;
      readonly cause: ChildExtensionDropCause;
    }
  | { readonly reason: "entry-duplicate"; readonly id: string };

export interface ChildExtensionPlan {
  readonly mode: ChildExtensionSelectionMode;
  /**
   * Argv-ready absolute paths, Weave first, in load order and deduplicated.
   * Always empty for `inherit-all`, which is how the spawn site knows to emit
   * no extension arguments at all.
   */
  readonly paths: readonly string[];
  readonly diagnostics: readonly ChildExtensionPlanDiagnostic[];
}

const INHERIT_ALL_PLAN: ChildExtensionPlan = Object.freeze({
  mode: "inherit-all",
  paths: Object.freeze([]) as readonly string[],
  diagnostics: Object.freeze([]) as readonly ChildExtensionPlanDiagnostic[],
});

/**
 * Turns a stored selection plus the live inventory into the child's extension
 * load list.
 *
 * Rules, in order:
 * - No record, or `inherit-all`: the child inherits the host's extensions and
 *   receives no extension arguments.
 * - An unusable Weave entry degrades to `inherit-all`. A child without the
 *   Weave adapter is worse than a child with too many extensions.
 * - `explicit`: Weave is always first and appears exactly once. Stored entries
 *   are matched by id against the live inventory; unmatched, unavailable, or
 *   unsafe entries are dropped with a diagnostic, and resolved paths come from
 *   the inventory so a stale stored path is never used.
 * - `explicit` with no surviving entries stays `explicit` and loads Weave
 *   only. It is never promoted back to `inherit-all`.
 */
export function resolveChildExtensionPlan(
  input: ChildExtensionPlanInput,
): ChildExtensionPlan {
  const record = input.record ?? DEFAULT_CHILD_EXTENSION_SELECTION;
  if (record.mode === "inherit-all") return INHERIT_ALL_PLAN;

  const weavePath = input.weaveEntry.path;
  if (!isSafeChildExtensionPath(weavePath)) {
    return {
      mode: "inherit-all",
      paths: [],
      diagnostics: [{ reason: "weave-entry-unusable" }],
    };
  }

  const available = new Map<string, ChildExtensionInventoryEntry>();
  for (const entry of input.inventory) {
    if (!available.has(entry.id)) available.set(entry.id, entry);
  }

  const diagnostics: ChildExtensionPlanDiagnostic[] = [];
  const paths: string[] = [weavePath];
  const seenPaths = new Set<string>([weavePath]);
  const seenIds = new Set<string>([input.weaveEntry.id]);

  for (const entry of record.entries) {
    if (seenIds.has(entry.id)) {
      diagnostics.push({ reason: "entry-duplicate", id: entry.id });
      continue;
    }
    seenIds.add(entry.id);
    const live = available.get(entry.id);
    if (live === undefined) {
      diagnostics.push({
        reason: "entry-dropped",
        id: entry.id,
        cause: "missing",
      });
      continue;
    }
    if (live.available === false) {
      diagnostics.push({
        reason: "entry-dropped",
        id: entry.id,
        cause: "unavailable",
      });
      continue;
    }
    if (!isSafeChildExtensionPath(live.path)) {
      diagnostics.push({
        reason: "entry-dropped",
        id: entry.id,
        cause: "path-unsafe",
      });
      continue;
    }
    if (seenPaths.has(live.path)) {
      diagnostics.push({ reason: "entry-duplicate", id: entry.id });
      continue;
    }
    seenPaths.add(live.path);
    paths.push(live.path);
  }

  return { mode: "explicit", paths, diagnostics };
}
