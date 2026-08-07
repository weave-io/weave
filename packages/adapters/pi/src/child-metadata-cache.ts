/**
 * Rebuildable, metadata-only child discovery cache (Spec 33, ADR 0014, plan
 * Task 6).
 *
 * This module owns an adapter-local `bun:sqlite` database used **only** to
 * make discovery bounded and fast: newest-N listing, deterministic cursor
 * pagination, and scoped cross-session history for the picker,
 * `/weave:history`, and the CLI.
 *
 * It is a *derivative*, never an authority:
 *
 * - the authoritative child transcript is the native Pi session file owned by
 *   `child-native-sessions.ts` (Task 4);
 * - the authoritative child metadata is the parent custom-entry ref owned by
 *   `child-session-refs.ts` (Task 5);
 * - every specific-child read revalidates the cached row against the injected
 *   {@link PiChildRefSourceAuthority} before returning it, and a source that
 *   is missing, corrupt, unavailable, or tombstoned marks the row stale and
 *   is never returned as authoritative;
 * - {@link PiChildMetadataCache.rebuild} discards and re-derives every
 *   non-tombstoned row from bounded parent refs plus source checks.
 *
 * The schema is metadata only. There is no column for a prompt, message,
 * assistant response, thinking block, tool call, tool result, transcript,
 * or any other child- or parent-produced content. `title` is the same
 * bounded label already carried in a ref.
 *
 * The database lives under the adapter's XDG data root
 * (`$XDG_DATA_HOME/weave/adapters/pi/cache/`, default
 * `~/.local/share/weave/adapters/pi/cache/`). Its directories are created
 * 0700 and the database file is 0600, established through a no-follow
 * `openat` chain so traversal, absolute escape, and symlinked components fail
 * closed instead of being repaired.
 *
 * Cache failure is never fatal. Open failure, permission failure, corruption,
 * and schema mismatch all resolve to a typed *degraded* outcome that carries
 * a bypass whose reads go straight to bounded parent-entry refs, so
 * delegation, settlement, and the live overlay for the current parent's
 * children keep working with no cache at all.
 */

import { dlopen, ptr, read } from "bun:ffi";
import { Database } from "bun:sqlite";
import { platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import { verifyNativeSessionRef } from "./child-native-sessions.js";
import type {
  PiChildRefRecord,
  PiChildRefSourceAuthority,
  PiChildRefSourceState,
} from "./child-session-refs.js";
import { enforceDurableChildTitle } from "./child-title.js";

// ---------------------------------------------------------------------------
// Layout and bounds
// ---------------------------------------------------------------------------

/** Fixed, XDG-rooted layout of the adapter-owned metadata cache. */
export const PI_CHILD_METADATA_CACHE_LAYOUT = Object.freeze({
  /** Root-relative segments appended to the resolved XDG data home. */
  segments: Object.freeze(["weave", "adapters", "pi", "cache"] as const),
  /** Database file name inside the cache root. */
  databaseFile: "child-metadata.sqlite",
  /** Mode every directory this module creates must have. */
  directoryMode: 0o700,
  /** Mode the database file must have. */
  fileMode: 0o600,
});

/** Versioned schema identity. A different stored version degrades the cache. */
export const PI_CHILD_METADATA_CACHE_SCHEMA_VERSION = 1 as const;

/** Hard bounds applied to every query, independent of caller input. */
export const PI_CHILD_METADATA_CACHE_BOUNDS = Object.freeze({
  /** Rows returned by one list call, independent of caller input. */
  maxPageSize: 200,
  /** Default page size when the caller asks for none. */
  defaultPageSize: 50,
  /** Refs consumed by one rebuild, independent of source size. */
  maxRebuildRefs: 1_000,
  /** Ceiling on any stored timestamp. */
  maxTimestamp: 4_102_444_800_000,
  /** Ceiling on any stored identifier. */
  maxIdLength: 256,
  /** Ceiling on the stored session ref. */
  maxRefLength: 1_024,
  /** Ceiling on the stored title. */
  maxTitleLength: 200,
  /** Ceiling on stored run labels. */
  maxLabelLength: 128,
  /** Ceiling on the stored run count. */
  maxRuns: 64,
  /** Ceiling on an opaque cursor, in characters. */
  maxCursorLength: 512,
});

/**
 * Every column name in the cache table. Exported so tests (and doctor) can
 * assert the schema carries no transcript-like field.
 */
export const PI_CHILD_METADATA_CACHE_COLUMNS: readonly string[] = Object.freeze(
  [
    "child_id",
    "thread_id",
    "native_session_id",
    "session_ref",
    "origin_parent_session",
    "origin_entry_id",
    "workspace_key",
    "title",
    "status",
    "created_at",
    "updated_at",
    "settled_at",
    "run_count",
    "latest_run_action",
    "latest_run_at",
    "latest_run_initiator",
    "latest_run_model",
    "latest_run_reasoning",
    "stale",
    "tombstoned",
    "cached_at",
  ],
);

/**
 * Column-name tokens that would indicate transcript or content storage. No
 * cache column may contain any of them.
 */
export const PI_CHILD_METADATA_FORBIDDEN_COLUMN_TOKENS: readonly string[] =
  Object.freeze([
    "prompt",
    "message",
    "content",
    "response",
    "assistant",
    "thinking",
    "reasoning_text",
    "tool",
    "transcript",
    "entries",
    "text",
    "output",
    "task",
    "body",
    "blob",
  ]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why the cache root itself was refused before any file was touched. */
export type PiChildMetadataCacheRootViolation =
  | "empty-home"
  | "relative-home"
  | "relative-xdg-data-home"
  | "path-escape";

/** Why the cache is unusable and callers must bypass it. */
export type PiChildMetadataCacheDegradeReason =
  | "root-violation"
  | "open-failed"
  | "permission"
  | "corrupt"
  | "schema-mismatch"
  | "io";

/** Closed failure set for every fallible cache operation. */
export type PiChildMetadataCacheError =
  | {
      readonly type: "CacheRootViolation";
      readonly reason: PiChildMetadataCacheRootViolation;
    }
  | {
      readonly type: "CacheUnavailable";
      readonly reason: PiChildMetadataCacheDegradeReason;
    }
  | { readonly type: "CacheRecordInvalid"; readonly issues: readonly string[] }
  | { readonly type: "CacheCursorInvalid" }
  | { readonly type: "CacheEntryMissing"; readonly childId: string }
  | {
      readonly type: "CacheEntryUnusable";
      readonly childId: string;
      readonly state: Exclude<PiChildRefSourceState, "available">;
    };

/** Closed failure set for the injected no-follow filesystem boundary. */
export type PiChildMetadataCacheFsError =
  | { readonly type: "unsafe-path" }
  | { readonly type: "symlink-rejected" }
  | { readonly type: "permissive-mode"; readonly kind: "directory" | "file" }
  | { readonly type: "wrong-kind"; readonly kind: "directory" | "file" }
  | { readonly type: "unavailable" }
  | { readonly type: "io" };

function degradeReasonFromFs(
  error: PiChildMetadataCacheFsError,
): PiChildMetadataCacheDegradeReason {
  switch (error.type) {
    case "unsafe-path":
    case "symlink-rejected":
      return "root-violation";
    case "permissive-mode":
      return "permission";
    case "wrong-kind":
      return "corrupt";
    case "unavailable":
      return "open-failed";
    default:
      return "io";
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const boundedString = (maxCharacters: number) =>
  z
    .string()
    .max(maxCharacters)
    .refine(
      (value) => textEncoder.encode(value).byteLength <= maxCharacters * 4,
      `string exceeds ${maxCharacters * 4} UTF-8 bytes`,
    );

/** Bun/Web-standard base64url encode — no Node `Buffer` in production. */
function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

/** Bun/Web-standard base64url decode — no Node `Buffer` in production. */
function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLength));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const idSchema = boundedString(PI_CHILD_METADATA_CACHE_BOUNDS.maxIdLength).pipe(
  z.string().min(1),
);
const labelSchema = boundedString(
  PI_CHILD_METADATA_CACHE_BOUNDS.maxLabelLength,
);
const timestampSchema = z
  .number()
  .int()
  .min(0)
  .max(PI_CHILD_METADATA_CACHE_BOUNDS.maxTimestamp);

const statusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "tombstoned",
]);

const runActionSchema = z.enum(["start", "retry", "continue"]);

/**
 * One cached child row. Metadata only: identity, scope, status, timing, and a
 * normalized summary of the newest run. Never transcript content.
 */
export const PiChildMetadataRecordSchema = z
  .object({
    childId: idSchema,
    threadId: idSchema,
    nativeSessionId: idSchema,
    sessionRef: boundedString(PI_CHILD_METADATA_CACHE_BOUNDS.maxRefLength).pipe(
      z
        .string()
        .min(1)
        .refine(
          (value) => verifyNativeSessionRef(value).isOk(),
          "sessionRef must be a contained root-relative session ref",
        ),
    ),
    originParentSessionId: idSchema,
    originEntryId: idSchema,
    workspaceKey: idSchema,
    title: boundedString(PI_CHILD_METADATA_CACHE_BOUNDS.maxTitleLength),
    status: statusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    settledAt: timestampSchema.optional(),
    runCount: z
      .number()
      .int()
      .min(0)
      .max(PI_CHILD_METADATA_CACHE_BOUNDS.maxRuns),
    latestRunAction: runActionSchema.optional(),
    latestRunAt: timestampSchema.optional(),
    latestRunInitiator: labelSchema.optional(),
    latestRunModel: labelSchema.optional(),
    latestRunReasoning: labelSchema.optional(),
    stale: z.boolean(),
    tombstoned: z.boolean(),
    cachedAt: timestampSchema,
  })
  .strict();
export type PiChildMetadataRecord = z.infer<typeof PiChildMetadataRecordSchema>;

/**
 * Validates one cache record. Never throws; failures are values.
 *
 * Rows cached before the durable-title fix hold a bounded first line of the
 * delegated task, and a cached row may also be written by a caller that never
 * went through the ref boundary. This boundary therefore proves title
 * provenance for itself (Threat Model T6, Warp blocker 1): an unproven title
 * is replaced by the deterministic identity-only fallback before the record
 * exists as a value, so no read, write, render, log, or error can observe it.
 * The replacement is idempotent, so a proven title never drifts.
 */
export function parseChildMetadataRecord(
  value: unknown,
): Result<PiChildMetadataRecord, PiChildMetadataCacheError> {
  const parsed = PiChildMetadataRecordSchema.safeParse(value);
  if (parsed.success) {
    const record = parsed.data;
    const title = enforceDurableChildTitle({
      title: record.title,
      threadId: record.threadId,
    });
    return ok(title === record.title ? record : { ...record, title });
  }
  return err({
    type: "CacheRecordInvalid",
    issues: parsed.error.issues.map((issue) => issue.path.join(".")),
  });
}

/**
 * Projects one Task 5 ref onto a cache record. Only fields already present in
 * the ref are copied; nothing is derived from transcript content.
 */
export function childMetadataRecordFromRef(input: {
  readonly ref: PiChildRefRecord;
  readonly workspaceKey: string;
  readonly cachedAt: number;
  readonly stale?: boolean;
  readonly tombstoned?: boolean;
}): Result<PiChildMetadataRecord, PiChildMetadataCacheError> {
  const { ref } = input;
  const latest = ref.runs.at(-1);
  const candidate = {
    childId: ref.childId,
    threadId: ref.threadId,
    nativeSessionId: ref.nativeSessionId,
    sessionRef: ref.sessionRef,
    originParentSessionId: ref.originParentSessionId,
    originEntryId: ref.originEntryId,
    workspaceKey: input.workspaceKey,
    title: ref.title,
    status: input.tombstoned === true ? ("tombstoned" as const) : ref.status,
    createdAt: ref.createdAt,
    updatedAt: ref.updatedAt,
    ...(ref.settledAt === undefined ? {} : { settledAt: ref.settledAt }),
    runCount: ref.runs.length,
    ...(latest === undefined
      ? {}
      : {
          latestRunAction: latest.action,
          latestRunAt: latest.startedAt,
          ...(latest.initiator === undefined
            ? {}
            : { latestRunInitiator: latest.initiator }),
          ...(latest.model === undefined
            ? {}
            : { latestRunModel: latest.model }),
          ...(latest.reasoning === undefined
            ? {}
            : { latestRunReasoning: latest.reasoning }),
        }),
    stale: input.stale ?? false,
    tombstoned: input.tombstoned ?? false,
    cachedAt: input.cachedAt,
  };
  return parseChildMetadataRecord(candidate);
}

// ---------------------------------------------------------------------------
// Scoping, cursors, and pages
// ---------------------------------------------------------------------------

/** Every query is scoped by workspace, and optionally by originating parent. */
export interface PiChildMetadataScope {
  readonly workspaceKey: string;
  /** When set, only children originating in this parent session match. */
  readonly parentSessionId?: string;
}

export interface PiChildMetadataListInput extends PiChildMetadataScope {
  /** Clamped to {@link PI_CHILD_METADATA_CACHE_BOUNDS.maxPageSize}. */
  readonly limit?: number;
  /** Opaque cursor from a previous page of the same scope. */
  readonly cursor?: string;
  /** Tombstoned rows are listed as tombstones only when asked for. */
  readonly includeTombstoned?: boolean;
}

/** Bounded index lookup by child id (metadata only; no transcripts/paths). */
export interface PiChildMetadataFindByChildIdInput {
  readonly workspaceKey: string;
  readonly childId: string;
  /** When set, only that immutable origin parent may match. */
  readonly parentSessionId?: string;
  /** Tombstoned rows are included only when asked for. */
  readonly includeTombstoned?: boolean;
  /** Clamped to {@link PI_CHILD_METADATA_CACHE_BOUNDS.maxPageSize}. */
  readonly limit?: number;
}

/** One deterministic page of newest-first cache rows. */
export interface PiChildMetadataPage {
  readonly records: readonly PiChildMetadataRecord[];
  /** Cursor for the next page, or `undefined` when the page is the last. */
  readonly nextCursor?: string;
}

const CursorSchema = z
  .object({
    v: z.literal(1),
    s: z.string().min(1).max(128),
    u: timestampSchema,
    c: timestampSchema,
    i: idSchema,
  })
  .strict();

function scopeFingerprint(scope: PiChildMetadataScope): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${scope.workspaceKey}\u0000${scope.parentSessionId ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

function encodeCursor(
  scope: PiChildMetadataScope,
  record: PiChildMetadataRecord,
): string {
  const payload = JSON.stringify({
    v: 1,
    s: scopeFingerprint(scope),
    u: record.updatedAt,
    c: record.createdAt,
    i: record.childId,
  });
  return encodeBase64Url(textEncoder.encode(payload));
}

function decodeCursor(
  scope: PiChildMetadataScope,
  cursor: string,
): Result<z.infer<typeof CursorSchema>, PiChildMetadataCacheError> {
  if (cursor.length > PI_CHILD_METADATA_CACHE_BOUNDS.maxCursorLength) {
    return err({ type: "CacheCursorInvalid" });
  }
  const decoded = Result.fromThrowable(
    () => JSON.parse(textDecoder.decode(decodeBase64Url(cursor))) as unknown,
    (): PiChildMetadataCacheError => ({ type: "CacheCursorInvalid" }),
  )();
  if (decoded.isErr()) return err(decoded.error);
  const parsed = CursorSchema.safeParse(decoded.value);
  if (!parsed.success) return err({ type: "CacheCursorInvalid" });
  if (parsed.data.s !== scopeFingerprint(scope)) {
    return err({ type: "CacheCursorInvalid" });
  }
  return ok(parsed.data);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return PI_CHILD_METADATA_CACHE_BOUNDS.defaultPageSize;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, PI_CHILD_METADATA_CACHE_BOUNDS.maxPageSize);
}

/**
 * Single-child get/stale/tombstone ops require an originating parent so the
 * composite identity `(workspace, parent, child)` cannot be ambiguous.
 */
function requireParentScope(
  scope: PiChildMetadataScope,
): Result<
  PiChildMetadataScope & { readonly parentSessionId: string },
  PiChildMetadataCacheError
> {
  if (
    scope.parentSessionId === undefined ||
    scope.parentSessionId.length === 0
  ) {
    return err({
      type: "CacheRecordInvalid",
      issues: ["parentSessionId"],
    });
  }
  return ok({
    workspaceKey: scope.workspaceKey,
    parentSessionId: scope.parentSessionId,
  });
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

export interface PiChildMetadataCacheRootInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}

/**
 * Resolves the fixed cache root. `XDG_DATA_HOME` wins when set and absolute;
 * a relative `XDG_DATA_HOME` or relative fallback `homeDir` is a root
 * violation, never a re-based or relative cache path.
 */
export function resolvePiChildMetadataCacheRoot(
  input: PiChildMetadataCacheRootInput = {},
): Result<string, PiChildMetadataCacheError> {
  const env = input.env ?? Bun.env;
  const home = input.homeDir ?? env.HOME ?? "";
  const configured = env.XDG_DATA_HOME;
  if (configured !== undefined && configured.length > 0) {
    if (!isAbsolute(configured)) {
      return err({
        type: "CacheRootViolation",
        reason: "relative-xdg-data-home",
      });
    }
    return ok(join(configured, ...PI_CHILD_METADATA_CACHE_LAYOUT.segments));
  }
  if (home.length === 0) {
    return err({ type: "CacheRootViolation", reason: "empty-home" });
  }
  if (!isAbsolute(home)) {
    return err({ type: "CacheRootViolation", reason: "relative-home" });
  }
  return ok(
    join(home, ".local", "share", ...PI_CHILD_METADATA_CACHE_LAYOUT.segments),
  );
}

// ---------------------------------------------------------------------------
// No-follow filesystem boundary
// ---------------------------------------------------------------------------

/**
 * Filesystem boundary the cache needs: create the cache root 0700 and the
 * database file 0600 without ever following a symlink, and report the mode of
 * an existing database file so a widened file fails closed.
 */
export interface PiChildMetadataCacheFsPort {
  ensureDirectory(
    path: string,
    mode: number,
  ): ResultAsync<void, PiChildMetadataCacheFsError>;
  /**
   * Creates the file with `mode` when missing and verifies its mode when it
   * already exists. Never widens, repairs, or truncates an existing file.
   */
  ensurePrivateFile(
    path: string,
    mode: number,
  ): ResultAsync<void, PiChildMetadataCacheFsError>;
  /**
   * Reports whether the private file already exists, without ever creating
   * it, its parent directories, or widening any mode.
   *
   * Read-only cache access uses this instead of `ensurePrivateFile`: a
   * pristine data root must stay byte-for-byte absent after a read command.
   * The method is optional so existing boundaries stay valid; a boundary that
   * omits it simply skips the probe, and the read-only database open — which
   * also never creates — remains the non-creating guarantee.
   */
  probePrivateFile?(
    path: string,
    mode: number,
  ): ResultAsync<PiChildMetadataCacheFileProbe, PiChildMetadataCacheFsError>;
}

/** Result of a non-creating existence probe of the database file. */
export type PiChildMetadataCacheFileProbe = "present" | "absent";

interface CacheLibcFlags {
  readonly O_RDONLY: number;
  readonly O_WRONLY: number;
  readonly O_CREAT: number;
  readonly O_EXCL: number;
  readonly O_DIRECTORY: number;
  readonly O_NOFOLLOW: number;
  readonly O_CLOEXEC: number;
}

interface CacheLibc {
  readonly flags: CacheLibcFlags;
  readonly open: (path: Uint8Array, flags: number, mode: number) => number;
  readonly openat: (
    dir: number,
    path: Uint8Array,
    flags: number,
    mode: number,
  ) => number;
  readonly mkdirat: (dir: number, path: Uint8Array, mode: number) => number;
  readonly fchmod: (fd: number, mode: number) => number;
  readonly close: (fd: number) => number;
  readonly errno: () => number;
  readonly dispose: () => void;
}

const ERRNO_ENOENT = 2;
const ERRNO_ENOTDIR = 20;
const ERRNO_EEXIST = 17;
const ERRNO_ELOOP_DARWIN = 62;
const ERRNO_ELOOP_LINUX = 40;

function cacheLibcFlags(): CacheLibcFlags | undefined {
  if (platform() === "darwin") {
    return {
      O_RDONLY: 0,
      O_WRONLY: 1,
      O_CREAT: 0x200,
      O_EXCL: 0x800,
      O_DIRECTORY: 0x100000,
      O_NOFOLLOW: 0x100,
      O_CLOEXEC: 0x1000000,
    };
  }
  if (platform() === "linux") {
    return {
      O_RDONLY: 0,
      O_WRONLY: 1,
      O_CREAT: 0x40,
      O_EXCL: 0x80,
      O_DIRECTORY: 0x10000,
      O_NOFOLLOW: 0x20000,
      O_CLOEXEC: 0x80000,
    };
  }
  return undefined;
}

function cstr(value: string): Uint8Array {
  return textEncoder.encode(`${value}\0`);
}

function libraryPathForPlatform(): string | undefined {
  if (platform() === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (platform() === "linux") return "libc.so.6";
  return undefined;
}

function errnoSymbolForPlatform(): string | undefined {
  if (platform() === "darwin") return "__error";
  if (platform() === "linux") return "__errno_location";
  return undefined;
}

function loadCacheLibc(): Result<CacheLibc, PiChildMetadataCacheFsError> {
  const flags = cacheLibcFlags();
  const libraryPath = libraryPathForPlatform();
  const errnoName = errnoSymbolForPlatform();
  if (
    flags === undefined ||
    libraryPath === undefined ||
    errnoName === undefined
  ) {
    return err({ type: "unavailable" });
  }
  return Result.fromThrowable(
    () =>
      dlopen(libraryPath, {
        open: { args: ["ptr", "i32", "i32"], returns: "i32" },
        openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
        mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
        fchmod: { args: ["i32", "i32"], returns: "i32" },
        close: { args: ["i32"], returns: "i32" },
        [errnoName]: { args: [], returns: "ptr" },
      }),
    (): PiChildMetadataCacheFsError => ({ type: "unavailable" }),
  )().map((library) => {
    const symbols = library.symbols as unknown as Record<
      string,
      (...args: never[]) => number
    > &
      Record<string, unknown>;
    const call = <T>(name: string): T => symbols[name] as unknown as T;
    return {
      flags,
      open: (path: Uint8Array, openFlags: number, mode: number) =>
        call<(p: unknown, f: number, m: number) => number>("open")(
          ptr(path),
          openFlags,
          mode,
        ),
      openat: (
        dir: number,
        path: Uint8Array,
        openFlags: number,
        mode: number,
      ) =>
        call<(d: number, p: unknown, f: number, m: number) => number>("openat")(
          dir,
          ptr(path),
          openFlags,
          mode,
        ),
      mkdirat: (dir: number, path: Uint8Array, mode: number) =>
        call<(d: number, p: unknown, m: number) => number>("mkdirat")(
          dir,
          ptr(path),
          mode,
        ),
      fchmod: (fd: number, mode: number) =>
        call<(f: number, m: number) => number>("fchmod")(fd, mode),
      close: (fd: number) => call<(f: number) => number>("close")(fd),
      errno: () =>
        read.i32(
          (symbols[errnoName] as unknown as () => unknown)() as never,
          0,
        ),
      dispose: () => library.close(),
    } satisfies CacheLibc;
  });
}

function absoluteSegments(
  path: string,
): Result<readonly string[], PiChildMetadataCacheFsError> {
  if (!isAbsolute(path)) return err({ type: "unsafe-path" });
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return err({ type: "unsafe-path" });
  }
  return ok(segments);
}

function isLoopErrno(value: number): boolean {
  return value === ERRNO_ELOOP_DARWIN || value === ERRNO_ELOOP_LINUX;
}

/**
 * Classifies a failed no-follow directory open. A symlinked or non-directory
 * component is a containment failure, never something to repair.
 */
function directoryOpenError(value: number): PiChildMetadataCacheFsError {
  if (isLoopErrno(value)) return { type: "symlink-rejected" };
  if (value === ERRNO_ENOTDIR) return { type: "wrong-kind", kind: "directory" };
  if (value === ERRNO_ENOENT) return { type: "unsafe-path" };
  return { type: "io" };
}

/**
 * Production no-follow filesystem for the cache root. Every component is
 * opened with `O_NOFOLLOW`; only components this call creates are chmoded,
 * and an existing component with the wrong mode fails closed.
 */
export class BunPiChildMetadataCacheFs implements PiChildMetadataCacheFsPort {
  ensureDirectory(
    path: string,
    mode: number,
  ): ResultAsync<void, PiChildMetadataCacheFsError> {
    return this.withDirectoryChain(path, true, mode, (libc, fd) => {
      libc.close(fd);
      return ok(undefined);
    });
  }

  ensurePrivateFile(
    path: string,
    mode: number,
  ): ResultAsync<void, PiChildMetadataCacheFsError> {
    const segments = absoluteSegments(path);
    if (segments.isErr()) return errAsync(segments.error);
    const fileName = segments.value.at(-1);
    if (fileName === undefined) return errAsync({ type: "unsafe-path" });
    const parent = `/${segments.value.slice(0, -1).join("/")}`;
    return this.withDirectoryChain(parent, false, mode, (libc, dirFd) =>
      this.openPrivateFile(libc, dirFd, fileName, mode),
    ).andThen((fd) => this.verifyFileMode(fd, mode));
  }

  /**
   * Non-creating existence probe. Walks the same no-follow chain as
   * `ensurePrivateFile` with creation disabled, so a missing root,
   * a missing cache directory, or a missing database file all answer
   * `absent` without a single `mkdirat` or `O_CREAT`.
   */
  probePrivateFile(
    path: string,
    mode: number,
  ): ResultAsync<PiChildMetadataCacheFileProbe, PiChildMetadataCacheFsError> {
    const segments = absoluteSegments(path);
    if (segments.isErr()) return errAsync(segments.error);
    const fileName = segments.value.at(-1);
    if (fileName === undefined) return errAsync({ type: "unsafe-path" });
    const parent = `/${segments.value.slice(0, -1).join("/")}`;
    return this.withDirectoryChain(
      parent,
      false,
      mode,
      (libc, dirFd): Result<number | "absent", PiChildMetadataCacheFsError> => {
        const fd = libc.openat(
          dirFd,
          cstr(fileName),
          libc.flags.O_RDONLY | libc.flags.O_NOFOLLOW | libc.flags.O_CLOEXEC,
          0,
        );
        if (fd >= 0) return ok(fd);
        const openErrno = libc.errno();
        if (isLoopErrno(openErrno)) return err({ type: "symlink-rejected" });
        if (openErrno === ERRNO_ENOENT) return ok("absent");
        return err({ type: "io" });
      },
    )
      .orElse((error) =>
        // A missing directory component of the chain is indistinguishable
        // from a missing file for a reader: both mean "nothing to read".
        error.type === "unsafe-path"
          ? okAsync<number | "absent", PiChildMetadataCacheFsError>("absent")
          : errAsync<number | "absent", PiChildMetadataCacheFsError>(error),
      )
      .andThen((fd) =>
        fd === "absent"
          ? okAsync<PiChildMetadataCacheFileProbe, PiChildMetadataCacheFsError>(
              "absent",
            )
          : this.verifyFileMode(fd, mode).map(
              (): PiChildMetadataCacheFileProbe => "present",
            ),
      );
  }

  private openPrivateFile(
    libc: CacheLibc,
    dirFd: number,
    fileName: string,
    mode: number,
  ): Result<number, PiChildMetadataCacheFsError> {
    const openFlags =
      libc.flags.O_RDONLY | libc.flags.O_NOFOLLOW | libc.flags.O_CLOEXEC;
    let fd = libc.openat(dirFd, cstr(fileName), openFlags, 0);
    if (fd < 0) {
      const openErrno = libc.errno();
      if (isLoopErrno(openErrno)) {
        libc.close(dirFd);
        return err({ type: "symlink-rejected" });
      }
      if (openErrno !== ERRNO_ENOENT) {
        libc.close(dirFd);
        return err({ type: "io" });
      }
      const created = libc.openat(
        dirFd,
        cstr(fileName),
        libc.flags.O_WRONLY |
          libc.flags.O_CREAT |
          libc.flags.O_EXCL |
          libc.flags.O_NOFOLLOW |
          libc.flags.O_CLOEXEC,
        mode,
      );
      if (created < 0) {
        libc.close(dirFd);
        return err({ type: "io" });
      }
      // The vararg `mode` is unreliable through FFI and is masked by umask,
      // so the intended mode is restored explicitly.
      const chmodResult = libc.fchmod(created, mode);
      libc.close(created);
      if (chmodResult !== 0) {
        libc.close(dirFd);
        return err({ type: "io" });
      }
      fd = libc.openat(dirFd, cstr(fileName), openFlags, 0);
      if (fd < 0) {
        libc.close(dirFd);
        return err({ type: "io" });
      }
    }
    libc.close(dirFd);
    return ok(fd);
  }

  private verifyFileMode(
    fd: number,
    mode: number,
  ): ResultAsync<void, PiChildMetadataCacheFsError> {
    return ResultAsync.fromThrowable(
      () => Bun.file(fd).stat(),
      (): PiChildMetadataCacheFsError => ({ type: "io" }),
    )().andThen((stat) => {
      if (!stat.isFile()) {
        return errAsync<void, PiChildMetadataCacheFsError>({
          type: "wrong-kind",
          kind: "file",
        });
      }
      if ((stat.mode & 0o7777) !== mode) {
        return errAsync<void, PiChildMetadataCacheFsError>({
          type: "permissive-mode",
          kind: "file",
        });
      }
      return okAsync<void, PiChildMetadataCacheFsError>(undefined);
    });
  }

  private withDirectoryChain<T>(
    path: string,
    create: boolean,
    mode: number,
    use: (
      libc: CacheLibc,
      fd: number,
    ) => Result<T, PiChildMetadataCacheFsError>,
  ): ResultAsync<T, PiChildMetadataCacheFsError> {
    const segments = absoluteSegments(path);
    if (segments.isErr()) return errAsync(segments.error);
    const loaded = loadCacheLibc();
    if (loaded.isErr()) return errAsync(loaded.error);
    const libc = loaded.value;
    const directoryFlags =
      libc.flags.O_RDONLY |
      libc.flags.O_DIRECTORY |
      libc.flags.O_NOFOLLOW |
      libc.flags.O_CLOEXEC;
    let current = libc.open(cstr("/"), directoryFlags, 0);
    if (current < 0) {
      libc.dispose();
      return errAsync({ type: "unavailable" });
    }
    for (const segment of segments.value) {
      let created = false;
      let next = libc.openat(current, cstr(segment), directoryFlags, 0);
      if (next < 0 && create && libc.errno() === ERRNO_ENOENT) {
        const made = libc.mkdirat(current, cstr(segment), mode);
        if (made !== 0 && libc.errno() !== ERRNO_EEXIST) {
          libc.close(current);
          libc.dispose();
          return errAsync({ type: "io" });
        }
        created = made === 0;
        next = libc.openat(current, cstr(segment), directoryFlags, 0);
      }
      if (next < 0) {
        const openErrno = libc.errno();
        libc.close(current);
        libc.dispose();
        return errAsync(directoryOpenError(openErrno));
      }
      if (created && libc.fchmod(next, mode) !== 0) {
        libc.close(next);
        libc.close(current);
        libc.dispose();
        return errAsync({ type: "io" });
      }
      libc.close(current);
      current = next;
    }
    const outcome = use(libc, current);
    libc.dispose();
    return outcome.isOk() ? okAsync(outcome.value) : errAsync(outcome.error);
  }
}

/** In-memory filesystem boundary for tests and for callers with no disk. */
export class FakePiChildMetadataCacheFs implements PiChildMetadataCacheFsPort {
  constructor(
    private readonly failure?: PiChildMetadataCacheFsError,
    readonly calls: string[] = [],
    /** What a non-creating probe reports when it does not fail. */
    private readonly probeAnswer: PiChildMetadataCacheFileProbe = "present",
  ) {}

  ensureDirectory(
    path: string,
  ): ResultAsync<void, PiChildMetadataCacheFsError> {
    this.calls.push(`dir:${path}`);
    return this.failure === undefined
      ? okAsync(undefined)
      : errAsync(this.failure);
  }

  ensurePrivateFile(
    path: string,
  ): ResultAsync<void, PiChildMetadataCacheFsError> {
    this.calls.push(`file:${path}`);
    return this.failure === undefined
      ? okAsync(undefined)
      : errAsync(this.failure);
  }

  probePrivateFile(
    path: string,
  ): ResultAsync<PiChildMetadataCacheFileProbe, PiChildMetadataCacheFsError> {
    this.calls.push(`probe:${path}`);
    return this.failure === undefined
      ? okAsync<PiChildMetadataCacheFileProbe, PiChildMetadataCacheFsError>(
          this.probeAnswer,
        )
      : errAsync(this.failure);
  }
}

// ---------------------------------------------------------------------------
// Source and bypass
// ---------------------------------------------------------------------------

/**
 * Bounded source of truth for a rebuild: the parent's custom-entry refs for
 * one workspace/parent scope, already validated by Task 5.
 */
export interface PiChildMetadataSource {
  readonly workspaceKey: string;
  readonly parentSessionId: string;
  /** Bounded parent-entry ref scan. Callers must not return transcripts. */
  readRefs(): ResultAsync<
    readonly PiChildRefRecord[],
    PiChildMetadataCacheError
  >;
}

/**
 * The read surface callers use when the cache is degraded. It answers from
 * bounded direct parent-entry scans, so discovery keeps working with no
 * database at all.
 */
export interface PiChildMetadataBypass {
  readonly degraded: true;
  readonly reason: PiChildMetadataCacheDegradeReason;
  list(
    input: PiChildMetadataListInput,
  ): ResultAsync<PiChildMetadataPage, PiChildMetadataCacheError>;
  findByChildId(
    input: PiChildMetadataFindByChildIdInput,
  ): ResultAsync<readonly PiChildMetadataRecord[], PiChildMetadataCacheError>;
}

/**
 * Builds the bypass reader over a bounded source scan. Ordering, scoping, and
 * cursor semantics match the cache exactly, so a degraded caller sees the same
 * page shape.
 */
export function createChildMetadataBypass(
  source: PiChildMetadataSource,
  reason: PiChildMetadataCacheDegradeReason,
  now: () => number = () => Date.now(),
): PiChildMetadataBypass {
  function loadScopedRecords(input: {
    readonly workspaceKey: string;
    readonly parentSessionId?: string;
    readonly includeTombstoned?: boolean;
  }): ResultAsync<readonly PiChildMetadataRecord[], PiChildMetadataCacheError> {
    if (input.workspaceKey !== source.workspaceKey) {
      return okAsync([]);
    }
    if (
      input.parentSessionId !== undefined &&
      input.parentSessionId !== source.parentSessionId
    ) {
      return okAsync([]);
    }
    const at = now();
    return source.readRefs().map((refs) => {
      const records: PiChildMetadataRecord[] = [];
      for (const ref of refs.slice(
        0,
        PI_CHILD_METADATA_CACHE_BOUNDS.maxRebuildRefs,
      )) {
        const record = childMetadataRecordFromRef({
          ref,
          workspaceKey: source.workspaceKey,
          cachedAt: at,
        });
        if (record.isErr()) continue;
        if (record.value.tombstoned && input.includeTombstoned !== true) {
          continue;
        }
        records.push(record.value);
      }
      records.sort(newestFirst);
      return records;
    });
  }

  return {
    degraded: true,
    reason,
    list(input) {
      const decoded =
        input.cursor === undefined
          ? ok(undefined)
          : decodeCursor(input, input.cursor).map((value) => value);
      if (decoded.isErr()) return errAsync(decoded.error);
      const cursor = decoded.value;
      return loadScopedRecords(input).map((records) => {
        const after =
          cursor === undefined
            ? records
            : records.filter((record) => isAfterCursor(record, cursor));
        return paginate(input, after);
      });
    },
    findByChildId(input) {
      return loadScopedRecords(input).map((records) => {
        const limit = clampLimit(input.limit);
        return records
          .filter((record) => record.childId === input.childId)
          .slice(0, limit);
      });
    },
  };
}

function newestFirst(
  a: PiChildMetadataRecord,
  b: PiChildMetadataRecord,
): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
  if (a.childId < b.childId) return -1;
  if (a.childId > b.childId) return 1;
  return 0;
}

function isAfterCursor(
  record: PiChildMetadataRecord,
  cursor: z.infer<typeof CursorSchema>,
): boolean {
  if (record.updatedAt !== cursor.u) return record.updatedAt < cursor.u;
  if (record.createdAt !== cursor.c) return record.createdAt < cursor.c;
  return record.childId > cursor.i;
}

function paginate(
  input: PiChildMetadataListInput,
  ordered: readonly PiChildMetadataRecord[],
): PiChildMetadataPage {
  const limit = clampLimit(input.limit);
  const page = ordered.slice(0, limit);
  const last = page.at(-1);
  if (last === undefined || ordered.length <= limit) return { records: page };
  return { records: page, nextCursor: encodeCursor(input, last) };
}

// ---------------------------------------------------------------------------
// SQLite boundary
// ---------------------------------------------------------------------------

/** The narrow slice of `bun:sqlite`'s `Database` this module uses. */
export interface PiChildMetadataDatabase {
  run(sql: string, params?: readonly unknown[]): void;
  all(sql: string, params?: readonly unknown[]): readonly unknown[];
  close(): void;
}

/** Opens the database at an already-contained absolute path. */
export type PiChildMetadataDatabaseOpener = (
  path: string,
) => PiChildMetadataDatabase;

/** Default opener: a real `bun:sqlite` database with no WAL side files. */
export const openBunChildMetadataDatabase: PiChildMetadataDatabaseOpener = (
  path,
) => {
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode=DELETE;");
  database.exec("PRAGMA foreign_keys=ON;");
  return {
    run(sql, params) {
      database.run(sql, (params ?? []) as never[]);
    },
    all(sql, params) {
      return database.query(sql).all(...((params ?? []) as never[]));
    },
    close() {
      database.close();
    },
  };
};

/**
 * Read-only opener: never creates the file, never creates or migrates a
 * table, and never writes a journal.
 *
 * `SQLITE_OPEN_READONLY` cannot create a database, `PRAGMA query_only=ON`
 * rejects any write statement at the SQLite layer, and the journal mode is
 * left untouched (the cache is always `DELETE`, so no `-wal`/`-shm` side
 * files can appear). `run` refuses before it reaches SQLite so a caller
 * bug is a typed failure rather than an attempted mutation.
 */
export const openBunChildMetadataDatabaseReadOnly: PiChildMetadataDatabaseOpener =
  (path) => {
    const database = new Database(path, { readonly: true, create: false });
    database.exec("PRAGMA query_only=ON;");
    return {
      run() {
        throw new Error(READ_ONLY_WRITE_REFUSED);
      },
      all(sql, params) {
        return database.query(sql).all(...((params ?? []) as never[]));
      },
      close() {
        database.close();
      },
    };
  };

/** Message used when a write is refused on a read-only cache handle. */
export const READ_ONLY_WRITE_REFUSED = "child metadata cache is read-only";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS cache_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS children (
  workspace_key         TEXT NOT NULL,
  child_id              TEXT NOT NULL,
  thread_id             TEXT NOT NULL,
  native_session_id     TEXT NOT NULL,
  session_ref           TEXT NOT NULL,
  origin_parent_session TEXT NOT NULL,
  origin_entry_id       TEXT NOT NULL,
  title                 TEXT NOT NULL,
  status                TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  settled_at            INTEGER,
  run_count             INTEGER NOT NULL,
  latest_run_action     TEXT,
  latest_run_at         INTEGER,
  latest_run_initiator  TEXT,
  latest_run_model      TEXT,
  latest_run_reasoning  TEXT,
  stale                 INTEGER NOT NULL,
  tombstoned            INTEGER NOT NULL,
  cached_at             INTEGER NOT NULL,
  PRIMARY KEY (workspace_key, origin_parent_session, child_id)
);
CREATE INDEX IF NOT EXISTS children_scope_recent
  ON children (workspace_key, origin_parent_session, updated_at DESC, created_at DESC, child_id);
`;

const ROW_COLUMNS = [
  "child_id",
  "thread_id",
  "native_session_id",
  "session_ref",
  "origin_parent_session",
  "origin_entry_id",
  "workspace_key",
  "title",
  "status",
  "created_at",
  "updated_at",
  "settled_at",
  "run_count",
  "latest_run_action",
  "latest_run_at",
  "latest_run_initiator",
  "latest_run_model",
  "latest_run_reasoning",
  "stale",
  "tombstoned",
  "cached_at",
].join(", ");

const RowSchema = z.looseObject({
  child_id: z.string(),
  thread_id: z.string(),
  native_session_id: z.string(),
  session_ref: z.string(),
  origin_parent_session: z.string(),
  origin_entry_id: z.string(),
  workspace_key: z.string(),
  title: z.string(),
  status: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  settled_at: z.number().nullable(),
  run_count: z.number(),
  latest_run_action: z.string().nullable(),
  latest_run_at: z.number().nullable(),
  latest_run_initiator: z.string().nullable(),
  latest_run_model: z.string().nullable(),
  latest_run_reasoning: z.string().nullable(),
  stale: z.number(),
  tombstoned: z.number(),
  cached_at: z.number(),
});

function optional<T>(value: T | null): Record<string, never> | { value: T } {
  return value === null ? ({} as Record<string, never>) : { value };
}

function rowToRecord(
  row: unknown,
): Result<PiChildMetadataRecord, PiChildMetadataCacheError> {
  const parsed = RowSchema.safeParse(row);
  if (!parsed.success) {
    return err({
      type: "CacheRecordInvalid",
      issues: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
  }
  const value = parsed.data;
  const settled = optional(value.settled_at);
  const runAt = optional(value.latest_run_at);
  const action = optional(value.latest_run_action);
  const initiator = optional(value.latest_run_initiator);
  const model = optional(value.latest_run_model);
  const reasoning = optional(value.latest_run_reasoning);
  return parseChildMetadataRecord({
    childId: value.child_id,
    threadId: value.thread_id,
    nativeSessionId: value.native_session_id,
    sessionRef: value.session_ref,
    originParentSessionId: value.origin_parent_session,
    originEntryId: value.origin_entry_id,
    workspaceKey: value.workspace_key,
    title: value.title,
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    ...("value" in settled ? { settledAt: settled.value } : {}),
    runCount: value.run_count,
    ...("value" in action ? { latestRunAction: action.value } : {}),
    ...("value" in runAt ? { latestRunAt: runAt.value } : {}),
    ...("value" in initiator ? { latestRunInitiator: initiator.value } : {}),
    ...("value" in model ? { latestRunModel: model.value } : {}),
    ...("value" in reasoning ? { latestRunReasoning: reasoning.value } : {}),
    stale: value.stale !== 0,
    tombstoned: value.tombstoned !== 0,
    cachedAt: value.cached_at,
  });
}

function recordParams(record: PiChildMetadataRecord): readonly unknown[] {
  return [
    record.workspaceKey,
    record.childId,
    record.threadId,
    record.nativeSessionId,
    record.sessionRef,
    record.originParentSessionId,
    record.originEntryId,
    record.title,
    record.status,
    record.createdAt,
    record.updatedAt,
    record.settledAt ?? null,
    record.runCount,
    record.latestRunAction ?? null,
    record.latestRunAt ?? null,
    record.latestRunInitiator ?? null,
    record.latestRunModel ?? null,
    record.latestRunReasoning ?? null,
    record.stale ? 1 : 0,
    record.tombstoned ? 1 : 0,
    record.cachedAt,
  ];
}

const UPSERT_SQL = `
INSERT INTO children (
  workspace_key, child_id, thread_id, native_session_id, session_ref,
  origin_parent_session, origin_entry_id, title, status, created_at,
  updated_at, settled_at, run_count, latest_run_action, latest_run_at,
  latest_run_initiator, latest_run_model, latest_run_reasoning, stale,
  tombstoned, cached_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (workspace_key, origin_parent_session, child_id) DO UPDATE SET
  thread_id = excluded.thread_id,
  native_session_id = excluded.native_session_id,
  session_ref = excluded.session_ref,
  origin_entry_id = excluded.origin_entry_id,
  title = excluded.title,
  status = CASE WHEN children.tombstoned = 1 THEN children.status ELSE excluded.status END,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  settled_at = excluded.settled_at,
  run_count = excluded.run_count,
  latest_run_action = excluded.latest_run_action,
  latest_run_at = excluded.latest_run_at,
  latest_run_initiator = excluded.latest_run_initiator,
  latest_run_model = excluded.latest_run_model,
  latest_run_reasoning = excluded.latest_run_reasoning,
  stale = excluded.stale,
  tombstoned = CASE WHEN children.tombstoned = 1 THEN 1 ELSE excluded.tombstoned END,
  cached_at = excluded.cached_at
`;

// ---------------------------------------------------------------------------
// Open outcome
// ---------------------------------------------------------------------------

/** What opening the cache produced: a live cache, or a typed bypass. */
export type PiChildMetadataCacheOpenOutcome =
  | { readonly mode: "active"; readonly cache: PiChildMetadataCache }
  | {
      readonly mode: "degraded";
      readonly error: PiChildMetadataCacheError;
      readonly bypass: PiChildMetadataBypass;
    };

export interface PiChildMetadataCacheOpenOptions {
  /** Absolute cache root; usually {@link resolvePiChildMetadataCacheRoot}. */
  readonly root: string;
  readonly fs: PiChildMetadataCacheFsPort;
  readonly authority: PiChildRefSourceAuthority;
  /** Bounded parent-entry source, used for rebuilds and for the bypass. */
  readonly source: PiChildMetadataSource;
  readonly openDatabase?: PiChildMetadataDatabaseOpener;
  readonly now?: () => number;
  /**
   * When `true`, open an existing database for reads only. Never creates the
   * cache root, database file, tables, schema rows, journals, or locks.
   * A missing cache degrades to a bounded empty bypass.
   */
  readonly readOnly?: boolean;
}

function degraded(
  options: PiChildMetadataCacheOpenOptions,
  error: PiChildMetadataCacheError,
  reason: PiChildMetadataCacheDegradeReason,
): PiChildMetadataCacheOpenOutcome {
  return {
    mode: "degraded",
    error,
    bypass: createChildMetadataBypass(options.source, reason, options.now),
  };
}

/**
 * Opens (or creates) the cache.
 *
 * This never rejects: an unreachable, unreadable, wrongly-permissioned,
 * corrupt, or version-mismatched database resolves to a degraded outcome
 * carrying the typed error and a bounded direct-scan bypass. Callers therefore
 * cannot be blocked by cache state.
 *
 * When {@link PiChildMetadataCacheOpenOptions.readOnly} is set, delegates to
 * {@link openPiChildMetadataCacheReadOnly} and never creates state.
 */
export function openPiChildMetadataCache(
  options: PiChildMetadataCacheOpenOptions,
): ResultAsync<PiChildMetadataCacheOpenOutcome, never> {
  if (options.readOnly === true) {
    return openPiChildMetadataCacheReadOnly(options);
  }
  const databasePath = join(
    options.root,
    PI_CHILD_METADATA_CACHE_LAYOUT.databaseFile,
  );
  return ResultAsync.fromSafePromise(
    options.fs
      .ensureDirectory(
        options.root,
        PI_CHILD_METADATA_CACHE_LAYOUT.directoryMode,
      )
      .andThen(() =>
        options.fs.ensurePrivateFile(
          databasePath,
          PI_CHILD_METADATA_CACHE_LAYOUT.fileMode,
        ),
      )
      .match(
        (): PiChildMetadataCacheOpenOutcome =>
          initializeDatabase(options, databasePath),
        (error): PiChildMetadataCacheOpenOutcome => {
          const reason = degradeReasonFromFs(error);
          return degraded(
            options,
            reason === "root-violation"
              ? { type: "CacheRootViolation", reason: "path-escape" }
              : { type: "CacheUnavailable", reason },
            reason,
          );
        },
      ),
  );
}

/**
 * Opens an existing cache for reads only.
 *
 * Never creates directories, the database file, tables, schema rows, WAL/SHM
 * side files, or lock artifacts. A missing database degrades to a bounded
 * empty bypass. An existing database is opened with
 * {@link openBunChildMetadataDatabaseReadOnly} (or a caller-supplied opener)
 * and schema is verified with SELECT only — never CREATE/INSERT/migrate.
 */
export function openPiChildMetadataCacheReadOnly(
  options: PiChildMetadataCacheOpenOptions,
): ResultAsync<PiChildMetadataCacheOpenOutcome, never> {
  const databasePath = join(
    options.root,
    PI_CHILD_METADATA_CACHE_LAYOUT.databaseFile,
  );
  const probe = options.fs.probePrivateFile?.bind(options.fs);
  if (probe === undefined) {
    return ResultAsync.fromSafePromise(
      Promise.resolve(initializeDatabaseReadOnly(options, databasePath)),
    );
  }
  return ResultAsync.fromSafePromise(
    probe(databasePath, PI_CHILD_METADATA_CACHE_LAYOUT.fileMode).match(
      (answer): PiChildMetadataCacheOpenOutcome => {
        if (answer === "absent") {
          return degraded(
            options,
            { type: "CacheUnavailable", reason: "open-failed" },
            "open-failed",
          );
        }
        return initializeDatabaseReadOnly(options, databasePath);
      },
      (error): PiChildMetadataCacheOpenOutcome => {
        const reason = degradeReasonFromFs(error);
        return degraded(
          options,
          reason === "root-violation"
            ? { type: "CacheRootViolation", reason: "path-escape" }
            : { type: "CacheUnavailable", reason },
          reason,
        );
      },
    ),
  );
}

function classifyOpenFailure(
  cause: unknown,
): PiChildMetadataCacheDegradeReason {
  const message = (
    cause instanceof Error ? cause.message : String(cause)
  ).toLowerCase();
  if (
    message.includes("not a database") ||
    message.includes("malformed") ||
    message.includes("encrypted") ||
    message.includes("corrupt")
  ) {
    return "corrupt";
  }
  if (message.includes("permission") || message.includes("readonly")) {
    return "permission";
  }
  return "open-failed";
}

function initializeDatabase(
  options: PiChildMetadataCacheOpenOptions,
  databasePath: string,
): PiChildMetadataCacheOpenOutcome {
  const opener = options.openDatabase ?? openBunChildMetadataDatabase;
  const opened = Result.fromThrowable(
    () => opener(databasePath),
    (cause): PiChildMetadataCacheError => ({
      type: "CacheUnavailable",
      reason: classifyOpenFailure(cause),
    }),
  )();
  if (opened.isErr()) {
    return degraded(
      options,
      opened.error,
      opened.error.type === "CacheUnavailable"
        ? opened.error.reason
        : "open-failed",
    );
  }
  const database = opened.value;
  const prepared = Result.fromThrowable(
    () => {
      for (const statement of CREATE_TABLE_SQL.split(";")) {
        const sql = statement.trim();
        if (sql.length > 0) database.run(sql);
      }
      const rows = database.all("SELECT value FROM cache_meta WHERE key = ?", [
        "schema_version",
      ]);
      const stored = rows.at(0);
      if (stored === undefined) {
        database.run("INSERT INTO cache_meta (key, value) VALUES (?, ?)", [
          "schema_version",
          String(PI_CHILD_METADATA_CACHE_SCHEMA_VERSION),
        ]);
        return "ready" as const;
      }
      const parsed = z.looseObject({ value: z.string() }).safeParse(stored);
      if (
        !parsed.success ||
        parsed.data.value !== String(PI_CHILD_METADATA_CACHE_SCHEMA_VERSION)
      ) {
        return "schema-mismatch" as const;
      }
      return "ready" as const;
    },
    (): PiChildMetadataCacheError => ({
      type: "CacheUnavailable",
      reason: "corrupt",
    }),
  )();
  if (prepared.isErr()) {
    Result.fromThrowable(
      () => database.close(),
      () => undefined,
    )();
    return degraded(options, prepared.error, "corrupt");
  }
  if (prepared.value === "schema-mismatch") {
    Result.fromThrowable(
      () => database.close(),
      () => undefined,
    )();
    return degraded(
      options,
      { type: "CacheUnavailable", reason: "schema-mismatch" },
      "schema-mismatch",
    );
  }
  return {
    mode: "active",
    cache: new PiChildMetadataCache({
      database,
      authority: options.authority,
      source: options.source,
      now: options.now ?? (() => Date.now()),
      readOnly: false,
    }),
  };
}

/**
 * Read-only open of an already-present database. SELECT-only schema check;
 * never CREATE/INSERT/migrate. Refuses writes on the returned cache.
 */
function initializeDatabaseReadOnly(
  options: PiChildMetadataCacheOpenOptions,
  databasePath: string,
): PiChildMetadataCacheOpenOutcome {
  const opener = options.openDatabase ?? openBunChildMetadataDatabaseReadOnly;
  const opened = Result.fromThrowable(
    () => opener(databasePath),
    (cause): PiChildMetadataCacheError => ({
      type: "CacheUnavailable",
      reason: classifyOpenFailure(cause),
    }),
  )();
  if (opened.isErr()) {
    return degraded(
      options,
      opened.error,
      opened.error.type === "CacheUnavailable"
        ? opened.error.reason
        : "open-failed",
    );
  }
  const database = opened.value;
  const prepared = Result.fromThrowable(
    () => {
      const rows = database.all("SELECT value FROM cache_meta WHERE key = ?", [
        "schema_version",
      ]);
      const stored = rows.at(0);
      if (stored === undefined) {
        return "schema-mismatch" as const;
      }
      const parsed = z.looseObject({ value: z.string() }).safeParse(stored);
      if (
        !parsed.success ||
        parsed.data.value !== String(PI_CHILD_METADATA_CACHE_SCHEMA_VERSION)
      ) {
        return "schema-mismatch" as const;
      }
      return "ready" as const;
    },
    (cause): PiChildMetadataCacheError => ({
      type: "CacheUnavailable",
      reason: classifyOpenFailure(cause),
    }),
  )();
  if (prepared.isErr()) {
    Result.fromThrowable(
      () => database.close(),
      () => undefined,
    )();
    return degraded(
      options,
      prepared.error,
      prepared.error.type === "CacheUnavailable"
        ? prepared.error.reason
        : "open-failed",
    );
  }
  if (prepared.value === "schema-mismatch") {
    Result.fromThrowable(
      () => database.close(),
      () => undefined,
    )();
    return degraded(
      options,
      { type: "CacheUnavailable", reason: "schema-mismatch" },
      "schema-mismatch",
    );
  }
  return {
    mode: "active",
    cache: new PiChildMetadataCache({
      database,
      authority: options.authority,
      source: options.source,
      now: options.now ?? (() => Date.now()),
      readOnly: true,
    }),
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface PiChildMetadataCacheInternalOptions {
  readonly database: PiChildMetadataDatabase;
  readonly authority: PiChildRefSourceAuthority;
  readonly source: PiChildMetadataSource;
  readonly now: () => number;
  /** When true, every write path fails closed without touching SQLite. */
  readonly readOnly: boolean;
}

/** Counts produced by one rebuild, for doctor and tests. */
export interface PiChildMetadataRebuildReport {
  readonly scannedRefs: number;
  readonly writtenRows: number;
  readonly staleRows: number;
  readonly retainedTombstones: number;
  readonly skippedRefs: number;
}

/**
 * Bounded, scoped, metadata-only discovery cache over the authoritative
 * parent refs and native sessions. Every fallible method returns a `Result`
 * or `ResultAsync`; expected database failures are values, never throws.
 */
export class PiChildMetadataCache {
  private readonly database: PiChildMetadataDatabase;
  private readonly authority: PiChildRefSourceAuthority;
  private readonly source: PiChildMetadataSource;
  private readonly now: () => number;
  private readonly readOnly: boolean;

  constructor(options: PiChildMetadataCacheInternalOptions) {
    this.database = options.database;
    this.authority = options.authority;
    this.source = options.source;
    this.now = options.now;
    this.readOnly = options.readOnly;
  }

  /** Whether this handle refuses every create/migrate/upsert/reconstruct path. */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  /** Column names actually present in the live table. */
  columns(): Result<readonly string[], PiChildMetadataCacheError> {
    return this.query("PRAGMA table_info(children)").andThen((rows) => {
      const names: string[] = [];
      for (const row of rows) {
        const parsed = z.looseObject({ name: z.string() }).safeParse(row);
        if (!parsed.success) {
          return err<readonly string[], PiChildMetadataCacheError>({
            type: "CacheRecordInvalid",
            issues: ["name"],
          });
        }
        names.push(parsed.data.name);
      }
      return ok<readonly string[], PiChildMetadataCacheError>(names);
    });
  }

  /** Inserts or refreshes one row. A tombstoned row is never resurrected. */
  upsert(
    record: PiChildMetadataRecord,
  ): Result<void, PiChildMetadataCacheError> {
    return parseChildMetadataRecord(record).andThen((validated) =>
      this.execute(UPSERT_SQL, recordParams(validated)),
    );
  }

  /** Projects one authoritative ref into the cache. */
  upsertRef(
    ref: PiChildRefRecord,
    workspaceKey: string,
    options: { readonly stale?: boolean } = {},
  ): Result<PiChildMetadataRecord, PiChildMetadataCacheError> {
    return childMetadataRecordFromRef({
      ref,
      workspaceKey,
      cachedAt: this.now(),
      ...(options.stale === undefined ? {} : { stale: options.stale }),
    }).andThen((record) => this.upsert(record).map(() => record));
  }

  /**
   * Newest-first page for one scope. Deterministic: ordering and cursors break
   * ties on `created_at` then `child_id`, so repeated pagination is stable.
   */
  list(
    input: PiChildMetadataListInput,
  ): Result<PiChildMetadataPage, PiChildMetadataCacheError> {
    const limit = clampLimit(input.limit);
    const params: unknown[] = [input.workspaceKey];
    let sql = `SELECT ${ROW_COLUMNS} FROM children WHERE workspace_key = ?`;
    if (input.parentSessionId !== undefined) {
      sql += " AND origin_parent_session = ?";
      params.push(input.parentSessionId);
    }
    if (input.includeTombstoned !== true) {
      sql += " AND tombstoned = 0";
    }
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input, input.cursor);
      if (cursor.isErr()) return err(cursor.error);
      sql +=
        " AND (updated_at < ? OR (updated_at = ? AND (created_at < ? OR (created_at = ? AND child_id > ?))))";
      params.push(
        cursor.value.u,
        cursor.value.u,
        cursor.value.c,
        cursor.value.c,
        cursor.value.i,
      );
    }
    sql += " ORDER BY updated_at DESC, created_at DESC, child_id ASC LIMIT ?";
    params.push(limit + 1);
    return this.query(sql, params).andThen((rows) => {
      const records: PiChildMetadataRecord[] = [];
      for (const row of rows) {
        const record = rowToRecord(row);
        if (record.isErr()) return err(record.error);
        records.push(record.value);
      }
      const page = records.slice(0, limit);
      const last = page.at(-1);
      if (records.length <= limit || last === undefined) {
        return ok<PiChildMetadataPage, PiChildMetadataCacheError>({
          records: page,
        });
      }
      return ok<PiChildMetadataPage, PiChildMetadataCacheError>({
        records: page,
        nextCursor: encodeCursor(input, last),
      });
    });
  }

  /**
   * Bounded metadata-index lookup by child id. Returns at most `limit` rows
   * (clamped). Never walks transcripts or returns filesystem paths. Optional
   * `parentSessionId` scopes to one immutable origin parent.
   */
  findByChildId(
    input: PiChildMetadataFindByChildIdInput,
  ): Result<readonly PiChildMetadataRecord[], PiChildMetadataCacheError> {
    const limit = clampLimit(input.limit);
    const params: unknown[] = [input.workspaceKey, input.childId];
    let sql = `SELECT ${ROW_COLUMNS} FROM children WHERE workspace_key = ? AND child_id = ?`;
    if (input.parentSessionId !== undefined) {
      sql += " AND origin_parent_session = ?";
      params.push(input.parentSessionId);
    }
    if (input.includeTombstoned !== true) {
      sql += " AND tombstoned = 0";
    }
    sql += " ORDER BY updated_at DESC, created_at DESC, child_id ASC LIMIT ?";
    params.push(limit);
    return this.query(sql, params).andThen((rows) => {
      const records: PiChildMetadataRecord[] = [];
      for (const row of rows) {
        const record = rowToRecord(row);
        if (record.isErr()) return err(record.error);
        records.push(record.value);
      }
      return ok(records);
    });
  }

  /**
   * Reads one specific child and validates it against the authoritative
   * source before returning it. A source that is missing, corrupt,
   * unavailable, or tombstoned marks the row stale (tombstoned sources also
   * mark the row tombstoned) and fails; the cache row is never returned as
   * authoritative in that case.
   *
   * Requires `parentSessionId` so the same child id under two parents cannot
   * cross-contaminate. Parent-omitted listing remains the cross-session path.
   */
  get(
    scope: PiChildMetadataScope,
    childId: string,
  ): ResultAsync<PiChildMetadataRecord, PiChildMetadataCacheError> {
    const parented = requireParentScope(scope);
    if (parented.isErr()) return errAsync(parented.error);
    const found = this.readRow(parented.value, childId);
    if (found.isErr()) return errAsync(found.error);
    const record = found.value;
    if (record === undefined) {
      return errAsync({ type: "CacheEntryMissing", childId });
    }
    if (record.tombstoned) {
      return errAsync({
        type: "CacheEntryUnusable",
        childId,
        state: "tombstoned",
      });
    }
    return this.authority
      .checkSource(record.sessionRef, record.originParentSessionId)
      .andThen((state) => {
        if (state === "available") {
          if (!record.stale) return okAsync(record);
          // Read-only handles never clear the stale bit on disk.
          if (this.readOnly) return okAsync(record);
          const refreshed = this.upsert({ ...record, stale: false });
          return refreshed.isErr()
            ? errAsync(refreshed.error)
            : okAsync({ ...record, stale: false });
        }
        if (this.readOnly) {
          return errAsync<PiChildMetadataRecord, PiChildMetadataCacheError>({
            type: "CacheEntryUnusable",
            childId,
            state,
          });
        }
        const marked = this.upsert({
          ...record,
          stale: true,
          tombstoned: state === "tombstoned",
          status: state === "tombstoned" ? "tombstoned" : record.status,
        });
        if (marked.isErr()) return errAsync(marked.error);
        return errAsync<PiChildMetadataRecord, PiChildMetadataCacheError>({
          type: "CacheEntryUnusable",
          childId,
          state,
        });
      });
  }

  /** Marks one row tombstoned. Tombstones are terminal. Requires parent scope. */
  tombstone(
    scope: PiChildMetadataScope,
    childId: string,
  ): Result<void, PiChildMetadataCacheError> {
    const parented = requireParentScope(scope);
    if (parented.isErr()) return err(parented.error);
    return this.execute(
      "UPDATE children SET tombstoned = 1, status = 'tombstoned', stale = 0, updated_at = ?, cached_at = ? WHERE workspace_key = ? AND child_id = ? AND origin_parent_session = ?",
      [
        this.now(),
        this.now(),
        parented.value.workspaceKey,
        childId,
        parented.value.parentSessionId,
      ],
    );
  }

  /** Marks one row stale without deleting it. Requires parent scope. */
  markStale(
    scope: PiChildMetadataScope,
    childId: string,
  ): Result<void, PiChildMetadataCacheError> {
    const parented = requireParentScope(scope);
    if (parented.isErr()) return err(parented.error);
    return this.execute(
      "UPDATE children SET stale = 1, cached_at = ? WHERE workspace_key = ? AND child_id = ? AND origin_parent_session = ?",
      [
        this.now(),
        parented.value.workspaceKey,
        childId,
        parented.value.parentSessionId,
      ],
    );
  }

  /**
   * Discards and re-derives every non-tombstoned row in the source's scope
   * from bounded parent refs plus per-child source checks. Tombstoned rows are
   * retained untouched and are never resurrected, even when a ref still
   * describes the child.
   */
  rebuild(): ResultAsync<
    PiChildMetadataRebuildReport,
    PiChildMetadataCacheError
  > {
    const scope: PiChildMetadataScope = {
      workspaceKey: this.source.workspaceKey,
      parentSessionId: this.source.parentSessionId,
    };
    const tombstoned = this.query(
      "SELECT child_id FROM children WHERE workspace_key = ? AND origin_parent_session = ? AND tombstoned = 1",
      [scope.workspaceKey, this.source.parentSessionId],
    ).andThen((rows) => {
      const ids = new Set<string>();
      for (const row of rows) {
        const parsed = z.looseObject({ child_id: z.string() }).safeParse(row);
        if (!parsed.success) {
          return err<Set<string>, PiChildMetadataCacheError>({
            type: "CacheRecordInvalid",
            issues: ["child_id"],
          });
        }
        ids.add(parsed.data.child_id);
      }
      return ok<Set<string>, PiChildMetadataCacheError>(ids);
    });
    if (tombstoned.isErr()) return errAsync(tombstoned.error);
    const cleared = this.execute(
      "DELETE FROM children WHERE workspace_key = ? AND origin_parent_session = ? AND tombstoned = 0",
      [scope.workspaceKey, this.source.parentSessionId],
    );
    if (cleared.isErr()) return errAsync(cleared.error);

    return this.source.readRefs().andThen((refs) => {
      const bounded = refs.slice(
        0,
        PI_CHILD_METADATA_CACHE_BOUNDS.maxRebuildRefs,
      );
      return ResultAsync.fromSafePromise(
        Promise.all(
          bounded.map((ref) =>
            this.authority
              .checkSource(ref.sessionRef, ref.originParentSessionId)
              .match(
                (state) => ({ ref, state }),
                (): {
                  readonly ref: PiChildRefRecord;
                  readonly state: PiChildRefSourceState;
                } => ({ ref, state: "unavailable" }),
              ),
          ),
        ),
      ).andThen((checked) =>
        this.writeRebuild(checked, tombstoned.value, bounded.length),
      );
    });
  }

  /** Closes the database. Idempotent from the caller's perspective. */
  close(): Result<void, PiChildMetadataCacheError> {
    return Result.fromThrowable(
      () => {
        this.database.close();
      },
      (): PiChildMetadataCacheError => ({
        type: "CacheUnavailable",
        reason: "io",
      }),
    )();
  }

  private writeRebuild(
    checked: readonly {
      readonly ref: PiChildRefRecord;
      readonly state: PiChildRefSourceState;
    }[],
    tombstoned: ReadonlySet<string>,
    scannedRefs: number,
  ): ResultAsync<PiChildMetadataRebuildReport, PiChildMetadataCacheError> {
    let writtenRows = 0;
    let staleRows = 0;
    let skippedRefs = 0;
    for (const { ref, state } of checked) {
      if (tombstoned.has(ref.childId)) {
        skippedRefs += 1;
        continue;
      }
      if (ref.originParentSessionId !== this.source.parentSessionId) {
        skippedRefs += 1;
        continue;
      }
      const stale = state !== "available" && state !== "tombstoned";
      const record = childMetadataRecordFromRef({
        ref,
        workspaceKey: this.source.workspaceKey,
        cachedAt: this.now(),
        stale,
        tombstoned: state === "tombstoned",
      });
      if (record.isErr()) {
        skippedRefs += 1;
        continue;
      }
      const written = this.upsert(record.value);
      if (written.isErr()) return errAsync(written.error);
      writtenRows += 1;
      if (stale) staleRows += 1;
    }
    return okAsync({
      scannedRefs,
      writtenRows,
      staleRows,
      retainedTombstones: tombstoned.size,
      skippedRefs,
    });
  }

  private readRow(
    scope: PiChildMetadataScope & { readonly parentSessionId: string },
    childId: string,
  ): Result<PiChildMetadataRecord | undefined, PiChildMetadataCacheError> {
    return this.query(
      `SELECT ${ROW_COLUMNS} FROM children WHERE workspace_key = ? AND child_id = ? AND origin_parent_session = ? LIMIT 1`,
      [scope.workspaceKey, childId, scope.parentSessionId],
    ).andThen((rows) => {
      const row = rows.at(0);
      if (row === undefined) {
        return ok<PiChildMetadataRecord | undefined, PiChildMetadataCacheError>(
          undefined,
        );
      }
      return rowToRecord(row);
    });
  }

  private query(
    sql: string,
    params: readonly unknown[] = [],
  ): Result<readonly unknown[], PiChildMetadataCacheError> {
    return Result.fromThrowable(
      () => this.database.all(sql, params),
      (): PiChildMetadataCacheError => ({
        type: "CacheUnavailable",
        reason: "corrupt",
      }),
    )();
  }

  private execute(
    sql: string,
    params: readonly unknown[],
  ): Result<void, PiChildMetadataCacheError> {
    if (this.readOnly) {
      return err({
        type: "CacheUnavailable",
        reason: "permission",
      });
    }
    return Result.fromThrowable(
      () => {
        this.database.run(sql, params);
      },
      (): PiChildMetadataCacheError => ({
        type: "CacheUnavailable",
        reason: "io",
      }),
    )();
  }
}
