/**
 * Storage-only owner of native Pi v3 child sessions (Spec 33, ADR 0014).
 *
 * Child transcripts live in real Pi session files created through the host's
 * own `SessionManager`, rooted at a Weave-owned directory outside Pi's default
 * session tree (`$XDG_DATA_HOME/weave/adapters/pi/sessions/`, default
 * `~/.local/share/weave/adapters/pi/sessions/`). Because the root is never
 * Pi's default session directory, these sessions are invisible to Pi's own
 * discovery/`/resume` listing while remaining fully readable through Pi's
 * native open/read APIs.
 *
 * This module is storage only. It creates, opens, lists by explicit ref,
 * reads live/historical native entries through the host, pages historical
 * JSONL entries through bounded `statFile`/`readFileRange` scans, and
 * explicitly deletes child sessions. It does not render, does not own parent
 * custom-entry refs (Task 5), does not cache (Task 6), does not prune, and
 * never falls back to an ephemeral `--no-session` child: a persistence
 * failure is returned as an error *before* the child task starts. Host entry
 * reads return `getEntries()` output only; paged reads never call the host
 * and never copy transcript bytes into adapter storage.
 *
 * Every filesystem touch goes through an injected no-follow
 * {@link PiNativeSessionFsPort} (the same libc `openat(O_NOFOLLOW)`
 * containment model `path-containment.ts` documents via
 * {@link isLexicallyContained}), so directories stay 0700, files stay 0600,
 * and traversal, absolute escape, and symlinked components fail closed
 * instead of being repaired. Tombstones are append-only: this module has
 * no code path that rewrites or truncates them.
 */

import { isAbsolute, join } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type {
  PiNativeResultAppendIdentity,
  PiNativeResultGroupRead,
  PiNativeResultGroupReadOptions,
  PiNativeResultGroupReadPlan,
  PiNativeResultReadIdentity,
  PiNativeResultScanBudget,
  PiNativeResultScanPage,
  PiNativeResultScanSource,
} from "./child-native-results.js";
import {
  appendResultGroup,
  bindResultGroupWriteMeta,
  exceedsResultScanBudget,
  PI_NATIVE_RESULT_GROUP_BOUNDS,
  planResultGroupWrite,
  prepareResultGroupRead,
  scanResultGroup,
} from "./child-native-results.js";
import type {
  PiNativeSessionCorruption,
  PiNativeSessionDirectory,
  PiNativeSessionError,
  PiNativeSessionFileHandle,
  PiNativeSessionFileStat,
  PiNativeSessionFsError,
  PiNativeSessionFsPort,
  PiNativeSessionHandle,
  PiNativeSessionHeader,
  PiNativeSessionHostPort,
  PiNativeSessionLock,
  PiNativeSessionRecord,
} from "./child-native-session-contracts.js";
import {
  decodeNativeSessionBase64Url,
  effectivePiNativeSessionMaxRangeLength,
  encodeNativeSessionBase64Url,
  fromFsError,
  PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS,
  PI_NATIVE_SESSION_MAX_FILE_BYTES,
  PI_NATIVE_SESSION_MAX_RANGE_LENGTH,
  PiNativeBoundedNameSchema,
} from "./child-native-session-contracts.js";
import {
  mintPiChildSessionLaunchGrant,
  type PiChildSessionLaunchAuthority,
  type PiChildSessionLaunchGrant,
} from "./child-session-launch.js";
import {
  type PiValidatedSessionHeader,
  validatedHeadersMatch,
  validatePiNativeSessionHeader,
} from "./native-session-header.js";
import { isLexicallyContained } from "./path-containment.js";
import {
  createBunPiTrustedDataRootPort,
  type PiTrustedDataRootPort,
  type PiTrustedDataRootViolation,
} from "./trusted-data-root.js";

// The durable-result protocol lives in `child-native-results.ts`. Its public
// surface is re-exported here so importers of the store keep one entry point.
export type {
  PiNativeResultAppendIdentity,
  PiNativeResultChunk,
  PiNativeResultCommit,
  PiNativeResultCommitIdentity,
  PiNativeResultGroupAcceptance,
  PiNativeResultGroupIncompleteReason,
  PiNativeResultGroupRead,
  PiNativeResultGroupReadOptions,
  PiNativeResultGroupState,
  PiNativeResultGroupSummary,
  PiNativeResultIdentity,
  PiNativeResultLeafIdentity,
  PiNativeResultReadIdentity,
  PiNativeResultScanLine,
  PiNativeResultScanPage,
  PiNativeResultScanSource,
} from "./child-native-results.js";
export {
  PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
  PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE,
  PI_NATIVE_RESULT_GROUP_BOUNDS,
  PI_NATIVE_RESULT_MAX_ENCODED_ENTRY_BYTES,
  PI_NATIVE_RESULT_MAX_ENCODED_GROUP_BYTES,
  PI_NATIVE_RESULT_SCHEMA_VERSION,
  PiNativeResultChunkSchema,
  PiNativeResultCommitIdentitySchema,
  PiNativeResultCommitSchema,
  readNativeResultGroup,
  scanResultGroup,
} from "./child-native-results.js";
// The failure taxonomy, the no-follow filesystem boundary, the host session
// boundary, and the read limits are declared once in the contracts module and
// re-exported here so existing importers of this module keep working.
export type {
  PiNativeSessionCorruption,
  PiNativeSessionDirectory,
  PiNativeSessionError,
  PiNativeSessionFileHandle,
  PiNativeSessionFileRange,
  PiNativeSessionFileStat,
  PiNativeSessionFsError,
  PiNativeSessionFsPort,
  PiNativeSessionGrantRefusal,
  PiNativeSessionHandle,
  PiNativeSessionHeader,
  PiNativeSessionHostPort,
  PiNativeSessionLock,
  PiNativeSessionRecord,
  PiNativeSessionRootViolation,
  PiNativeSessionStorageUnavailable,
  PiNativeSessionStorageUnavailableReason,
} from "./child-native-session-contracts.js";
export {
  describePiNativeSessionStorageUnavailable,
  PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS,
  PI_NATIVE_SESSION_MAX_FILE_BYTES,
  PI_NATIVE_SESSION_MAX_RANGE_LENGTH,
  setPiNativeSessionMaxRangeLengthForTests,
} from "./child-native-session-contracts.js";
export type { PiValidatedSessionHeader } from "./native-session-header.js";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Fixed, XDG-rooted layout of the Weave-owned native child session tree. */
export const PI_NATIVE_SESSION_LAYOUT = Object.freeze({
  /** Root-relative segments appended to the resolved XDG data home. */
  segments: Object.freeze(["weave", "adapters", "pi", "sessions"] as const),
  /** Append-only deletion ledger, stored at the root of the session tree. */
  tombstoneFile: "tombstones.jsonl",
  /** Mode every directory this module creates must have. */
  directoryMode: 0o700,
  /** Mode every file this module creates or accepts must have. */
  fileMode: 0o600,
  /** Hard ceiling on one list-by-ref call, independent of caller input. */
  maxListedSessions: 100,
});

const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;
const MAX_COMPONENT_LENGTH = 64;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** Schema version of {@link PiNativeSessionEntryCursor}. */
export const PI_NATIVE_SESSION_ENTRY_CURSOR_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

export interface PiNativeSessionRootInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  /**
   * Canonicalizer for the configured XDG data base. Production wires the
   * libc `realpath(3)` port; unit tests with synthetic absolute paths wire
   * {@link IdentityPiTrustedDataRootPort}.
   */
  readonly trustedRoot?: PiTrustedDataRootPort;
}

/**
 * Resolves the fixed session root. `XDG_DATA_HOME` wins when set and absolute;
 * a relative `XDG_DATA_HOME` is a root violation rather than a silently
 * re-based path.
 *
 * The configured base (`$XDG_DATA_HOME`, else `$HOME/.local/share`) is
 * canonicalized first, so a user-owned symlinked base - the common
 * `~/.local -> dotfiles/.local` layout - resolves to its real target instead
 * of failing closed against the no-follow chain below. Only the base may be
 * a symlink: the adapter-owned `weave/adapters/pi/sessions` components are
 * appended *after* canonicalization and still opened with strict
 * `openat(O_NOFOLLOW)`, so nothing at or below the adapter root is ever
 * followed.
 */
export function resolvePiNativeSessionRoot(
  input: PiNativeSessionRootInput = {},
): ResultAsync<string, PiNativeSessionError> {
  const env = input.env ?? Bun.env;
  const home = input.homeDir ?? env.HOME ?? "";
  const trustedRoot = input.trustedRoot ?? createBunPiTrustedDataRootPort();
  const configured = env.XDG_DATA_HOME;
  let base: string;
  if (configured !== undefined && configured.length > 0) {
    if (!isAbsolute(configured)) {
      return errAsync({
        type: "SessionRootViolation",
        reason: "relative-xdg-data-home",
      });
    }
    base = configured;
  } else {
    if (home.length === 0) {
      return errAsync({ type: "SessionRootViolation", reason: "empty-home" });
    }
    base = join(home, ".local", "share");
  }
  return trustedRoot
    .canonicalize(base)
    .map((canonicalBase) =>
      join(canonicalBase, ...PI_NATIVE_SESSION_LAYOUT.segments),
    )
    .mapErr((violation) => fromTrustedRootViolation(violation, base));
}

/** Maps a trusted-base canonicalization failure onto a root violation. */
function fromTrustedRootViolation(
  violation: PiTrustedDataRootViolation,
  base: string,
): PiNativeSessionError {
  switch (violation) {
    case "relative-data-root":
      return {
        type: "SessionRootViolation",
        reason: base.length === 0 ? "empty-home" : "relative-xdg-data-home",
      };
    case "unresolvable-data-root":
      return { type: "SessionRootViolation", reason: "unresolvable-data-root" };
    case "non-directory-data-root":
      return {
        type: "SessionRootViolation",
        reason: "non-directory-data-root",
      };
    case "foreign-data-root":
      return { type: "SessionRootViolation", reason: "foreign-data-root" };
    case "writable-data-root":
      return { type: "SessionRootViolation", reason: "writable-data-root" };
    default:
      return {
        type: "SessionStorageUnavailable",
        reason: "filesystem-unavailable",
      };
  }
}

/**
 * True when the Weave session root shares no ancestry with Pi's default
 * session directory, so Pi's own discovery can never list a child session.
 */
export function isDisjointFromDefaultSessionTree(
  sessionRoot: string,
  defaultSessionDir: string,
): boolean {
  const left = `${sessionRoot.replace(/\/+$/, "")}/`;
  const right = `${defaultSessionDir.replace(/\/+$/, "")}/`;
  return !left.startsWith(right) && !right.startsWith(left);
}

/**
 * Maps an arbitrary child id onto one safe path component. Unsafe or
 * over-long ids are hashed rather than rejected, so a child id can never
 * express `..`, an absolute path, or a separator.
 */
export function safeNativeSessionComponent(
  childId: string,
): Result<string, PiNativeSessionError> {
  if (childId.length === 0) {
    return err({ type: "SessionRootViolation", reason: "unsafe-component" });
  }
  if (
    childId.length <= MAX_COMPONENT_LENGTH &&
    SAFE_COMPONENT.test(childId) &&
    childId !== "." &&
    childId !== ".."
  ) {
    return ok(childId);
  }
  return ok(new Bun.CryptoHasher("sha256").update(childId).digest("hex"));
}

/**
 * Verifies a root-relative session ref stays lexically inside the session
 * root. Absolute refs, `..` segments, and empty segments are refused.
 */
export function verifyNativeSessionRef(
  ref: string,
): Result<string, PiNativeSessionError> {
  if (!isLexicallyContained(ref)) {
    return err({ type: "SessionRootViolation", reason: "path-escape" });
  }
  const segments = ref.split("/");
  if (segments.some((segment) => !SAFE_COMPONENT.test(segment))) {
    return err({ type: "SessionRootViolation", reason: "unsafe-component" });
  }
  return ok(ref);
}

// ---------------------------------------------------------------------------
// Records and states
// ---------------------------------------------------------------------------

/**
 * Validated session metadata plus host `getEntries()` output. Entries are
 * returned by reference from the host handle; this module never persists or
 * duplicates transcript bytes into adapter files.
 */
export interface PiNativeSessionEntries {
  readonly record: PiNativeSessionRecord;
  readonly entries: readonly unknown[];
}

/**
 * Strict opaque cursor payload for bounded native JSONL entry paging.
 * Encoded as base64url JSON for the public string form; callers never need
 * to inspect fields, but the schema rejects unknown keys and wrong versions.
 */
export const PiNativeSessionEntryCursorSchema = z
  .object({
    version: z.literal(PI_NATIVE_SESSION_ENTRY_CURSOR_VERSION),
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    /** Absolute byte offset of the anchored entry's line start. */
    offset: z.number().int().nonnegative(),
    /**
     * Which page edge produced this cursor: `older` means load further older
     * entries strictly before `offset`; `newer` means load further newer
     * entries strictly after that entry's line.
     */
    anchor: z.enum(["older", "newer"]),
  })
  .strict();

export type PiNativeSessionEntryCursor = z.infer<
  typeof PiNativeSessionEntryCursorSchema
>;

/** Page scan direction for {@link PiNativeSessionStore.readSessionEntryPage}. */
export type PiNativeSessionEntryPageDirection =
  | "newest"
  | "older"
  | "newer"
  | "at";

/** One parsed JSONL body line (header lines are never returned). */
export type PiNativeSessionPagedEntry =
  | {
      readonly kind: "entry";
      readonly offset: number;
      /** Stable opaque cursor anchored to this exact JSONL record. */
      readonly cursor?: string;
      readonly value: unknown;
    }
  | {
      readonly kind: "corrupt";
      readonly offset: number;
      /** Stable opaque cursor anchored to this exact JSONL record. */
      readonly cursor?: string;
      readonly reason: "invalid-json" | "not-object" | "empty";
    };

/** One bounded native session entry page. */
export interface PiNativeSessionEntryPage {
  readonly entries: readonly PiNativeSessionPagedEntry[];
  readonly olderCursor?: string;
  readonly newerCursor?: string;
  readonly bytesRead: number;
  readonly linesScanned: number;
}

export interface PiNativeSessionEntryPageOptions {
  readonly direction: PiNativeSessionEntryPageDirection;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Bounded, typed view of one requested ref. */
export type PiNativeSessionState =
  | { readonly state: "available"; readonly record: PiNativeSessionRecord }
  | { readonly state: "missing"; readonly ref: string }
  | {
      readonly state: "corrupt";
      readonly ref: string;
      readonly reason: PiNativeSessionCorruption;
    }
  | {
      readonly state: "unavailable";
      readonly ref: string;
      readonly error: PiNativeSessionError;
    };

/** Phase of one append-only native deletion ledger record. */
export type PiNativeSessionDeletionPhase = "intent" | "failed" | "completed";

/** Append-only deletion ledger record, including recoverable partial states. */
export interface PiNativeSessionDeletionRecord {
  readonly version: 1;
  readonly ref: string;
  readonly childId: string;
  readonly parentSession: string;
  readonly deletedAt: string;
  readonly reason: "explicit-user-deletion";
  readonly phase: PiNativeSessionDeletionPhase;
}

/** Completed append-only deletion record. Legacy lines omit `phase`. */
export interface PiNativeSessionTombstone {
  readonly version: 1;
  readonly ref: string;
  readonly childId: string;
  readonly parentSession: string;
  readonly deletedAt: string;
  readonly reason: "explicit-user-deletion";
  readonly phase?: PiNativeSessionDeletionPhase;
}

/**
 * Deterministic confirmation token a caller must echo back to delete a child
 * session. Deletion is never implicit: a wrong or absent token is refused.
 */
export function nativeSessionDeletionToken(ref: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`weave-pi-delete\u0000${ref}`)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Whether this store may authorize launches, stated explicitly at
 * construction (Spec 33 path-session design §5.3 / R5).
 *
 * There is no default. A read-only store - diagnostics, history, doctor,
 * inspection - must say `read-only` and then physically cannot mint a grant;
 * a launching store must present the generation-scoped launch authority the
 * same object graph proved readiness with. Omission used to mean "read-only",
 * which made a missing wiring look like a policy decision.
 */
export type PiNativeSessionStoreLaunchMode =
  | { readonly mode: "read-only" }
  | {
      readonly mode: "authorized";
      readonly authority: PiChildSessionLaunchAuthority;
    };

export interface PiNativeSessionStoreOptions {
  readonly root: string;
  readonly fs: PiNativeSessionFsPort;
  readonly host: PiNativeSessionHostPort;
  readonly now?: () => Date;
  /**
   * Mandatory statement of whether this store may mint launch grants, and
   * from which generation-scoped authority.
   */
  readonly launch: PiNativeSessionStoreLaunchMode;
}

/** What a caller must prove before a validated session may launch a child. */
export interface MintNativeSessionLaunchGrantInput {
  /**
   * The child process this grant authorizes. A thread's later runs use fresh
   * child ids, so the grant is bound to the id that will actually launch,
   * never to the id that originally created the session.
   */
  readonly childId: string;
  /**
   * A record this store itself validated and returned. Provenance is object
   * identity: a structurally identical record built by a caller carries no
   * proof and is refused with `unproven-session`.
   */
  readonly record: PiNativeSessionRecord;
  readonly activeLeafId: string;
  readonly checkpointCursor?: number;
}

export interface CreateNativeChildSessionInput {
  readonly childId: string;
  readonly parentSession: string;
  readonly cwd: string;
}

// ---------------------------------------------------------------------------
// Thread metadata entry
// ---------------------------------------------------------------------------

/** Custom entry type carrying one thread's rebuildable identity. */
export const PI_NATIVE_THREAD_ENTRY_TYPE = "weave.child.thread";
/** Schema version of {@link PiNativeThreadMetadata}. */
export const PI_NATIVE_THREAD_SCHEMA_VERSION = 1;

/**
 * The bounded, metadata-only state a thread must be able to rebuild from its
 * own authoritative session: who ran it, under whom, where, and with which
 * model intent. It carries no task text, no response, and no filesystem path.
 */
export const PiNativeThreadMetadataSchema = z
  .object({
    schemaVersion: z.literal(PI_NATIVE_THREAD_SCHEMA_VERSION),
    threadId: PiNativeBoundedNameSchema,
    agentName: PiNativeBoundedNameSchema,
    parentId: PiNativeBoundedNameSchema,
    parentAgentName: PiNativeBoundedNameSchema,
    parentDepth: z.number().int().min(0).max(64),
    ownerParentSessionId: PiNativeBoundedNameSchema,
    cwd: z.string().min(1).max(4_096),
    model: PiNativeBoundedNameSchema.optional(),
    reasoning: PiNativeBoundedNameSchema.optional(),
    createdAt: z.number().int().min(0),
  })
  .strict();

export type PiNativeThreadMetadata = z.infer<
  typeof PiNativeThreadMetadataSchema
>;

/** Caller-supplied thread metadata; the schema version is added here. */
export type PiNativeThreadMetadataInput = Omit<
  PiNativeThreadMetadata,
  "schemaVersion"
>;

const NativeThreadEntryRecordSchema = z.looseObject({
  type: z.string().optional(),
  customType: z.string().optional(),
  data: z.unknown(),
});

/** JSON values accepted as native session body entries. */
const NativeSessionEntryValueSchema = z.union([
  z.looseObject({}),
  z.array(z.unknown()),
]);

const NativeSessionDeletionPhaseSchema = z.enum([
  "intent",
  "failed",
  "completed",
]);

/** Legacy-compatible parser for one append-only deletion record. */
const NativeSessionDeletionRecordSchema = z
  .object({
    version: z.literal(1),
    ref: z.string(),
    childId: z.string(),
    parentSession: z.string().nullable().optional(),
    deletedAt: z.string(),
    phase: NativeSessionDeletionPhaseSchema.optional(),
  })
  .passthrough();

/**
 * Finds the newest valid thread metadata entry in a native session's entries.
 * Malformed or foreign entries are ignored, never repaired; an absence is
 * reported to the caller as an absence.
 */
export function readNativeThreadMetadata(
  entries: readonly unknown[],
): PiNativeThreadMetadata | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entryRecord = NativeThreadEntryRecordSchema.safeParse(entries[index]);
    if (!entryRecord.success) continue;
    if (entryRecord.data.customType !== PI_NATIVE_THREAD_ENTRY_TYPE) continue;
    const parsed = PiNativeThreadMetadataSchema.safeParse(
      entryRecord.data.data,
    );
    if (!parsed.success) continue;
    return parsed.data;
  }
  return undefined;
}

function withDirectory<T>(
  fs: PiNativeSessionFsPort,
  path: string,
  create: boolean,
  ref: string,
  use: (
    directory: PiNativeSessionDirectory,
  ) => ResultAsync<T, PiNativeSessionError>,
): ResultAsync<T, PiNativeSessionError> {
  return fs
    .openDirectory(path, create)
    .mapErr((error) => fromFsError(error, ref))
    .andThen((directory) =>
      use(directory)
        .map((value) => {
          directory.close();
          return value;
        })
        .mapErr((error) => {
          directory.close();
          return error;
        }),
    );
}

/** Encode a validated cursor payload as an opaque base64url string. */
export function encodePiNativeSessionEntryCursor(
  cursor: PiNativeSessionEntryCursor,
): Result<string, PiNativeSessionError> {
  const parsed = PiNativeSessionEntryCursorSchema.safeParse(cursor);
  if (!parsed.success) {
    return err({
      type: "SessionCorrupt",
      ref: "",
      reason: "invalid-cursor",
    });
  }
  const encoded = encodeNativeSessionBase64Url(
    textEncoder.encode(JSON.stringify(parsed.data)),
  );
  if (encoded.length > PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxCursorLength) {
    return err({
      type: "SessionCorrupt",
      ref: "",
      reason: "invalid-cursor",
    });
  }
  return ok(encoded);
}

/** Decode and strictly validate an opaque entry-page cursor. */
export function decodePiNativeSessionEntryCursor(
  cursor: string,
  ref: string,
): Result<PiNativeSessionEntryCursor, PiNativeSessionError> {
  if (
    cursor.length === 0 ||
    cursor.length > PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxCursorLength
  ) {
    return err({ type: "SessionCorrupt", ref, reason: "invalid-cursor" });
  }
  const bytes = decodeNativeSessionBase64Url(cursor);
  if (bytes.isErr()) {
    return err({ type: "SessionCorrupt", ref, reason: "invalid-cursor" });
  }
  const json = Result.fromThrowable(
    () => JSON.parse(textDecoder.decode(bytes.value)),
    () => void 0,
  )();
  if (json.isErr()) {
    return err({ type: "SessionCorrupt", ref, reason: "invalid-cursor" });
  }
  const parsed = PiNativeSessionEntryCursorSchema.safeParse(json.value);
  if (!parsed.success) {
    return err({ type: "SessionCorrupt", ref, reason: "invalid-cursor" });
  }
  return ok(parsed.data);
}

interface LocatedLine {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

interface PageScanState {
  bytesRead: number;
  linesScanned: number;
}

/** Where a validated session header ends, and the id it declares. */
interface PiNativeSessionHeaderPosition {
  /** First body byte offset: one past the header line's newline. */
  readonly headerEnd: number;
  /** Native session id from the header, absent when the header omits it. */
  readonly sessionId?: string;
}

function clampEntryPageLimit(limit: number | undefined): number {
  if (limit === undefined) return PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLimit;
  if (!Number.isSafeInteger(limit) || limit < 1) return 0;
  return Math.min(limit, PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLimit);
}

function cursorMatchesIdentity(
  cursor: PiNativeSessionEntryCursor,
  identity: PiNativeSessionFileStat,
): PiNativeSessionCorruption | undefined {
  if (cursor.dev !== identity.dev || cursor.ino !== identity.ino) {
    return "stale-cursor";
  }
  if (identity.size < cursor.size || identity.size < cursor.offset) {
    return "stale-cursor";
  }
  return undefined;
}

function parseJsonlBodyLine(
  offset: number,
  lineBytes: Uint8Array,
): PiNativeSessionPagedEntry {
  if (lineBytes.length === 0) {
    return { kind: "corrupt", offset, reason: "empty" };
  }
  const text = textDecoder.decode(lineBytes);
  const parsed = Result.fromThrowable(
    () => JSON.parse(text),
    () => void 0,
  )();
  if (parsed.isErr()) {
    return { kind: "corrupt", offset, reason: "invalid-json" };
  }
  const entry = NativeSessionEntryValueSchema.safeParse(parsed.value);
  if (!entry.success) {
    return { kind: "corrupt", offset, reason: "not-object" };
  }
  return { kind: "entry", offset, value: entry.data };
}

/**
 * Assembles exactly `length` bytes (budget/capped) by calling the handle's
 * public {@link PiNativeSessionFileHandle.readRange} in a loop. Each call
 * performs one content read with full fd+leaf checks; short nonzero chunks
 * resume at `offset + consumed`. A premature zero-length read before the
 * window is complete fails closed — never a partial success that would let
 * backward paging skip an unread suffix.
 */
function readRangeExact(
  handle: PiNativeSessionFileHandle,
  offset: number,
  length: number,
  ref: string,
  state: PageScanState,
  expected: PiNativeSessionFileStat,
): ResultAsync<Uint8Array, PiNativeSessionError> {
  if (length === 0) {
    return okAsync(new Uint8Array());
  }
  const remaining =
    PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned - state.bytesRead;
  if (remaining <= 0) {
    return errAsync({
      type: "SessionCorrupt",
      ref,
      reason: "unreadable",
    });
  }
  const capped = Math.min(
    length,
    remaining,
    effectivePiNativeSessionMaxRangeLength(),
  );
  const chunks: Uint8Array[] = [];
  let consumed = 0;

  const readNext = (): ResultAsync<Uint8Array, PiNativeSessionError> => {
    if (consumed >= capped) {
      return okAsync(concatChunks(chunks, consumed));
    }
    const need = capped - consumed;
    return handle
      .readRange(offset + consumed, need)
      .mapErr((error) => fromFsError(error, ref))
      .andThen((range) => {
        if (!sameFileIdentity(range.identity, expected)) {
          return errAsync<Uint8Array, PiNativeSessionError>({
            type: "SessionCorrupt",
            ref,
            reason: "stale-cursor",
          });
        }
        if (range.bytes.length === 0) {
          // Premature EOF: the requested window is not complete.
          return errAsync<Uint8Array, PiNativeSessionError>({
            type: "SessionCorrupt",
            ref,
            reason: "unreadable",
          });
        }
        chunks.push(range.bytes);
        consumed += range.bytes.length;
        state.bytesRead += range.bytes.length;
        if (consumed >= capped) {
          return okAsync(concatChunks(chunks, consumed));
        }
        // Short nonzero chunk: retry through public readRange so the next
        // content read gets its own before/after fd+leaf checks.
        return readNext();
      });
  };

  return readNext();
}

/**
 * Reads complete newline-delimited lines forward from `start` up to (but not
 * past) `endExclusive`. Stops on byte/line budgets or `maxLines`. A line
 * without a trailing newline is yielded only when `endExclusive` is EOF.
 */
function readLinesForward(
  handle: PiNativeSessionFileHandle,
  start: number,
  endExclusive: number,
  ref: string,
  state: PageScanState,
  identity: PiNativeSessionFileStat,
  maxLines: number = Number.POSITIVE_INFINITY,
): ResultAsync<readonly LocatedLine[], PiNativeSessionError> {
  if (start >= endExclusive || maxLines <= 0) return okAsync([]);

  const collect = (
    cursor: number,
    carry: Uint8Array,
    carryOffset: number,
    lines: LocatedLine[],
  ): ResultAsync<readonly LocatedLine[], PiNativeSessionError> => {
    if (
      lines.length >= maxLines ||
      state.bytesRead >= PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned ||
      state.linesScanned >= PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLinesScanned
    ) {
      return okAsync(lines);
    }
    if (cursor >= endExclusive && carry.length === 0) return okAsync(lines);

    if (cursor >= endExclusive) {
      if (endExclusive === identity.size && carry.length > 0) {
        if (carry.length > PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes) {
          return errAsync({
            type: "SessionCorrupt",
            ref,
            reason: "line-too-long",
          });
        }
        state.linesScanned += 1;
        lines.push({ offset: carryOffset, bytes: carry });
      }
      return okAsync(lines);
    }

    const want = Math.min(
      effectivePiNativeSessionMaxRangeLength(),
      endExclusive - cursor,
      PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned - state.bytesRead,
    );
    if (want <= 0) return okAsync(lines);

    return readRangeExact(handle, cursor, want, ref, state, identity).andThen(
      (chunk) => {
        if (chunk.length === 0) return okAsync(lines);

        let lineStart = 0;
        const merged =
          carry.length === 0
            ? chunk
            : (() => {
                const next = new Uint8Array(carry.length + chunk.length);
                next.set(carry);
                next.set(chunk, carry.length);
                return next;
              })();
        const baseOffset = carry.length === 0 ? cursor : carryOffset;

        for (let index = 0; index < merged.length; index += 1) {
          if (merged[index] !== 0x0a) continue;
          const length = index - lineStart;
          if (length > PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes) {
            return errAsync<readonly LocatedLine[], PiNativeSessionError>({
              type: "SessionCorrupt",
              ref,
              reason: "line-too-long",
            });
          }
          if (
            lines.length >= maxLines ||
            state.linesScanned >=
              PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLinesScanned
          ) {
            return okAsync(lines);
          }
          state.linesScanned += 1;
          lines.push({
            offset: baseOffset + lineStart,
            bytes: merged.subarray(lineStart, index),
          });
          lineStart = index + 1;
          if (lines.length >= maxLines) return okAsync(lines);
        }

        const rest =
          lineStart < merged.length
            ? merged.subarray(lineStart).slice()
            : new Uint8Array();
        if (rest.length > PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes) {
          return errAsync<readonly LocatedLine[], PiNativeSessionError>({
            type: "SessionCorrupt",
            ref,
            reason: "line-too-long",
          });
        }

        return collect(
          cursor + chunk.length,
          rest,
          lineStart < merged.length
            ? baseOffset + lineStart
            : cursor + chunk.length,
          lines,
        );
      },
    );
  };

  return collect(start, new Uint8Array(), start, []);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const next = new Uint8Array(left.length + right.length);
  next.set(left);
  next.set(right, left.length);
  return next;
}

function lineTooLongError(ref: string): PiNativeSessionError {
  return { type: "SessionCorrupt", ref, reason: "line-too-long" };
}

function pushCollectedLine(
  collected: LocatedLine[],
  state: PageScanState,
  maxLines: number,
  line: LocatedLine,
  ref: string,
): Result<"continue" | "full", PiNativeSessionError> {
  if (line.bytes.length > PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes) {
    return err(lineTooLongError(ref));
  }
  if (
    collected.length >= maxLines ||
    state.linesScanned >= PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLinesScanned
  ) {
    return ok("full");
  }
  state.linesScanned += 1;
  collected.push(line);
  return collected.length >= maxLines ||
    state.linesScanned >= PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLinesScanned
    ? ok("full")
    : ok("continue");
}

/**
 * Scans complete lines backward from `endExclusive` down toward `startFloor`.
 * Returned lines are newest-first. Newline is a byte delimiter (UTF-8 safe).
 * A trailing file newline does not invent an empty line; an unterminated
 * final line at EOF is yielded when the scan reaches `startFloor`.
 */
function readLinesBackward(
  handle: PiNativeSessionFileHandle,
  endExclusive: number,
  startFloor: number,
  ref: string,
  state: PageScanState,
  identity: PiNativeSessionFileStat,
  maxLines: number,
): ResultAsync<readonly LocatedLine[], PiNativeSessionError> {
  if (endExclusive <= startFloor || maxLines <= 0) return okAsync([]);

  const collected: LocatedLine[] = [];

  /**
   * `buffer` holds the incomplete right-hand fragment whose absolute start is
   * `bufferOffset` — bytes not yet closed by a newline to their left.
   */
  const step = (
    pos: number,
    buffer: Uint8Array,
    bufferOffset: number,
  ): ResultAsync<readonly LocatedLine[], PiNativeSessionError> => {
    if (
      collected.length >= maxLines ||
      state.bytesRead >= PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned ||
      state.linesScanned >= PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLinesScanned
    ) {
      return okAsync(collected);
    }

    if (pos <= startFloor) {
      if (buffer.length > 0) {
        const pushed = pushCollectedLine(
          collected,
          state,
          maxLines,
          { offset: bufferOffset, bytes: buffer },
          ref,
        );
        if (pushed.isErr()) return errAsync(pushed.error);
      }
      return okAsync(collected);
    }

    const want = Math.min(
      effectivePiNativeSessionMaxRangeLength(),
      pos - startFloor,
      PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned - state.bytesRead,
    );
    if (want <= 0) {
      if (buffer.length > 0) {
        const pushed = pushCollectedLine(
          collected,
          state,
          maxLines,
          { offset: bufferOffset, bytes: buffer },
          ref,
        );
        if (pushed.isErr()) return errAsync(pushed.error);
      }
      return okAsync(collected);
    }

    const offset = pos - want;
    return readRangeExact(handle, offset, want, ref, state, identity).andThen(
      (chunk) => {
        const merged = concatBytes(chunk, buffer);
        const base = offset;

        // Split merged into newline-terminated segments.
        // segments[0] may still be incomplete (needs bytes to the left).
        // segments[1..] are definitely complete.
        // The fragment after the final newline is newer than every segment and
        // must be emitted before them (newest-first). It is empty when merged
        // ends with \n.
        const segments: LocatedLine[] = [];
        let start = 0;
        const newlineAt: number[] = [];
        for (let index = 0; index < merged.length; index += 1) {
          if (merged[index] === 0x0a) newlineAt.push(index);
        }

        if (newlineAt.length === 0) {
          if (
            merged.length > PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes
          ) {
            return errAsync(lineTooLongError(ref));
          }
          return step(offset, merged.slice(), base);
        }

        for (const nl of newlineAt) {
          segments.push({
            offset: base + start,
            bytes: merged.subarray(start, nl),
          });
          start = nl + 1;
        }
        const rightFragment = merged.subarray(start);

        // Newest-first: rightFragment (unterminated or carried right tail) is
        // newer than every newline-terminated segment in this merge.
        if (rightFragment.length > 0) {
          const pushedTail = pushCollectedLine(
            collected,
            state,
            maxLines,
            { offset: base + start, bytes: rightFragment.slice() },
            ref,
          );
          if (pushedTail.isErr()) return errAsync(pushedTail.error);
          if (pushedTail.value === "full") return okAsync(collected);
        }

        const definite = segments.slice(1);
        for (let index = definite.length - 1; index >= 0; index -= 1) {
          const line = definite[index];
          if (line === undefined || line.offset < startFloor) continue;
          const pushed = pushCollectedLine(
            collected,
            state,
            maxLines,
            line,
            ref,
          );
          if (pushed.isErr()) return errAsync(pushed.error);
          if (pushed.value === "full") return okAsync(collected);
        }

        const head = segments[0];
        if (head === undefined) return okAsync(collected);

        if (offset === startFloor) {
          const pushedHead = pushCollectedLine(
            collected,
            state,
            maxLines,
            head,
            ref,
          );
          if (pushedHead.isErr()) return errAsync(pushedHead.error);
          return okAsync(collected);
        }

        if (
          head.bytes.length > PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes
        ) {
          return errAsync(lineTooLongError(ref));
        }
        return step(offset, head.bytes.slice(), head.offset);
      },
    );
  };

  return step(endExclusive, new Uint8Array(), endExclusive);
}

/** True when a read failed only because the whole-session ceiling was hit. */
function isFileTooLarge(error: PiNativeSessionError): boolean {
  return error.type === "SessionCorrupt" && error.reason === "file-too-large";
}

/**
 * Reads and validates only the first (header) line of a session file through
 * an already-open descriptor. Bounded by one line, so it works on sessions
 * that are too large for a whole-session read.
 */
function readSessionHeaderLine(
  handle: PiNativeSessionFileHandle,
  ref: string,
  expectedParentSession: string | undefined,
): ResultAsync<PiValidatedSessionHeader, PiNativeSessionError> {
  const state: PageScanState = { bytesRead: 0, linesScanned: 0 };
  return handle
    .stat()
    .mapErr((error) => fromFsError(error, ref))
    .andThen((identity) => {
      if (identity.size === 0) {
        return errAsync<PiValidatedSessionHeader, PiNativeSessionError>({
          type: "SessionCorrupt",
          ref,
          reason: "missing-header",
        });
      }
      return readLinesForward(
        handle,
        0,
        Math.min(identity.size, PI_NATIVE_SESSION_MAX_RANGE_LENGTH),
        ref,
        state,
        identity,
        1,
      ).andThen((lines) => {
        const line = lines[0];
        if (line === undefined) {
          return errAsync<PiValidatedSessionHeader, PiNativeSessionError>({
            type: "SessionCorrupt",
            ref,
            reason: "missing-header",
          });
        }
        const parsed = parseJsonlBodyLine(line.offset, line.bytes);
        if (parsed.kind !== "entry") {
          return errAsync<PiValidatedSessionHeader, PiNativeSessionError>({
            type: "SessionCorrupt",
            ref,
            reason: "missing-header",
          });
        }
        const validated = validateChildSessionHeader(
          parsed.value,
          expectedParentSession,
        );
        if (validated.isErr()) {
          return errAsync<PiValidatedSessionHeader, PiNativeSessionError>({
            type: "SessionCorrupt",
            ref,
            reason: validated.error,
          });
        }
        return okAsync<PiValidatedSessionHeader, PiNativeSessionError>(
          validated.value,
        );
      });
    });
}

/**
 * Validates one candidate header for a *child* session: the complete strict
 * Pi v3 contract, plus the parent link this adapter always writes and always
 * requires. Used by every read/reopen path, so a header refused at create can
 * never be accepted later.
 */
function validateChildSessionHeader<TCandidate>(
  candidate: TCandidate,
  expectedParent: string | undefined,
): Result<PiValidatedSessionHeader, PiNativeSessionCorruption> {
  const validated = validatePiNativeSessionHeader(candidate);
  if (validated.isErr()) {
    return err(
      validated.error === "unsupported-version"
        ? "unsupported-version"
        : "missing-header",
    );
  }
  const header = validated.value;
  // Every Weave child session carries the immutable parent link this adapter
  // wrote at create. A session without one is not this adapter's, and one
  // that names a different parent belongs to another parent session.
  if (header.parentSession === undefined) return err("parent-session-mismatch");
  if (expectedParent !== undefined && header.parentSession !== expectedParent) {
    return err("parent-session-mismatch");
  }
  return ok(header);
}

/**
 * Headers this store will persist verbatim before spawn. Missing host fields
 * are never invented; an incomplete, exotic, or wrong-version header fails as
 * `header-unusable`. The parent link and cwd must be exactly the ones this
 * store asked the host to create.
 */
function persistableHostHeader<THeader>(
  header: THeader,
  input: CreateNativeChildSessionInput,
): Result<PiValidatedSessionHeader, "header-unusable"> {
  const validated = validatePiNativeSessionHeader(header);
  if (validated.isErr()) return err("header-unusable");
  if (validated.value.parentSession !== input.parentSession) {
    return err("header-unusable");
  }
  if (validated.value.cwd !== input.cwd) return err("header-unusable");
  return ok(validated.value);
}

/**
 * Canonical immediate-child equality. A prefix test (`startsWith`) accepts
 * `<dir>/nested/leaf.jsonl`, so the leaf must instead sit directly inside the
 * directory this store opened and handed to Pi.
 */
function isImmediateChildPath(directory: string, candidate: string): boolean {
  const separator = candidate.lastIndexOf("/");
  if (separator <= 0) return false;
  const basename = candidate.slice(separator + 1);
  return (
    candidate.slice(0, separator) === directory &&
    basename.length > 0 &&
    basename !== "." &&
    basename !== ".."
  );
}

/** Every identity fact one Pi session handle reports, read exactly once. */
interface HostSessionIdentity {
  readonly sessionFile: string | undefined;
  readonly sessionDir: string;
  readonly sessionId: string;
  /** Exactly what the host reported, never assumed to have been validated. */
  readonly header: unknown;
  readonly persisted: boolean;
}

/**
 * Reads the complete identity of one host handle behind a throw boundary. A
 * getter that throws is a host failure, not a trusted answer, so it maps to a
 * typed path-free failure instead of escaping the seam.
 *
 * Every identity surface is read here - `getSessionFile`, `getSessionDir`,
 * `getSessionId`, `getHeader`, and `isPersisted` - so no caller can read one
 * of them outside the boundary, and so a host that answers one getter
 * correctly and another one hostilely is refused as a whole.
 */
function readHostSessionIdentity(
  handle: PiNativeSessionHandle,
  onThrow: () => PiNativeSessionError = () => ({
    type: "SessionCreateFailed",
    reason: "host-threw",
  }),
): Result<HostSessionIdentity, PiNativeSessionError> {
  return Result.fromThrowable(
    (): HostSessionIdentity => ({
      sessionFile: handle.getSessionFile(),
      sessionDir: handle.getSessionDir(),
      sessionId: handle.getSessionId(),
      header: handle.getHeader(),
      persisted: handle.isPersisted(),
    }),
    onThrow,
  )();
}

const headerLineEncoder = new TextEncoder();

/**
 * Hard ceiling on entries returned by one descriptor-safe whole-session read.
 * Independent of caller input; a longer session fails closed rather than
 * silently truncating a transcript a caller would treat as complete.
 */
const MAX_DESCRIPTOR_SESSION_ENTRIES = 20_000;

/**
 * Hard ceiling on lines examined by one descriptor-safe whole-session read.
 * Applied while chunks stream in, so a pathological single-line-per-byte file
 * fails closed before the parser allocates a projection.
 */
const MAX_DESCRIPTOR_SESSION_LINES = 32_768;

/**
 * Reads one whole session file through an already-open, identity-bound
 * descriptor and never by name.
 *
 * Order of enforcement:
 * 1. The size captured when the descriptor was opened is checked against
 *    `maxBytes` before a single body byte is allocated.
 * 2. Chunks are read positionally from that same descriptor in
 *    `<= PI_NATIVE_SESSION_MAX_RANGE_LENGTH` windows, with the cumulative
 *    total bounded by `maxBytes + 1`. The extra sentinel byte proves a file
 *    that grew past the ceiling after the metadata check, which fails closed
 *    rather than truncating. An initially empty file still issues one guarded
 *    EOF probe (`readRange(0, sentinelLength)`) and final held-fd/leaf
 *    verification before returning empty — there is no zero-size fast path.
 * 3. Each `readRange` performs at most one OS content read. A short read is
 *    resumed by calling `readRange` again, so held-fd and descriptor-relative
 *    leaf checks surround every content read.
 * 4. Line and entry budgets are applied while reading, not after. A non-empty
 *    final line without a trailing newline counts toward the line ceiling, and
 *    the ceiling is enforced before any chunk is concatenated or parsed.
 * 5. The descriptor identity is re-verified after every chunk and once more at
 *    the end. Growth, truncation, replacement, or in-place mutation yields a
 *    typed error and no partial projection.
 */
function readBoundedFile(
  handle: PiNativeSessionFileHandle,
  ref: string,
  maxBytes: number,
): ResultAsync<Uint8Array, PiNativeSessionError> {
  const opened = handle.identity;
  if (opened.size > maxBytes) {
    return errAsync({ type: "SessionCorrupt", ref, reason: "file-too-large" });
  }

  const ceiling = maxBytes + 1;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let lines = 0;
  let lastByte: number | undefined;

  const readNext = (
    offset: number,
  ): ResultAsync<Uint8Array, PiNativeSessionError> => {
    const want = Math.min(
      effectivePiNativeSessionMaxRangeLength(),
      ceiling - total,
    );
    if (want <= 0) {
      return errAsync({
        type: "SessionCorrupt",
        ref,
        reason: "file-too-large",
      });
    }
    return handle
      .readRange(offset, want)
      .mapErr((error) => fromFsError(error, ref))
      .andThen((range) => {
        if (!sameFileIdentity(range.identity, opened)) {
          return errAsync<Uint8Array, PiNativeSessionError>({
            type: "SessionCorrupt",
            ref,
            reason: "stale-cursor",
          });
        }
        if (range.bytes.length === 0) {
          // EOF. A non-empty unterminated final line still counts as a line,
          // and that budget is checked before anything is concatenated.
          const totalLines = total > 0 && lastByte !== 0x0a ? lines + 1 : lines;
          if (totalLines > MAX_DESCRIPTOR_SESSION_LINES) {
            return errAsync<Uint8Array, PiNativeSessionError>({
              type: "SessionCorrupt",
              ref,
              reason: "unreadable",
            });
          }
          // The descriptor must still be the file we validated.
          return handle
            .stat()
            .mapErr((error) => fromFsError(error, ref))
            .andThen((current) =>
              sameFileIdentity(current, opened) && total === opened.size
                ? okAsync<Uint8Array, PiNativeSessionError>(
                    concatChunks(chunks, total),
                  )
                : errAsync<Uint8Array, PiNativeSessionError>({
                    type: "SessionCorrupt",
                    ref,
                    reason: "stale-cursor",
                  }),
            );
        }
        for (const byte of range.bytes) {
          if (byte !== 0x0a) continue;
          lines += 1;
          if (lines > MAX_DESCRIPTOR_SESSION_LINES) {
            return errAsync<Uint8Array, PiNativeSessionError>({
              type: "SessionCorrupt",
              ref,
              reason: "unreadable",
            });
          }
        }
        chunks.push(range.bytes);
        total += range.bytes.length;
        lastByte = range.bytes[range.bytes.length - 1];
        if (total > maxBytes) {
          return errAsync<Uint8Array, PiNativeSessionError>({
            type: "SessionCorrupt",
            ref,
            reason: "file-too-large",
          });
        }
        // Short or full chunk: resume with a fresh readRange so the next
        // content read gets its own before/after fd+leaf checks.
        return readNext(offset + range.bytes.length);
      });
  };

  return readNext(0);
}

function sameFileIdentity(
  left: PiNativeSessionFileStat,
  right: PiNativeSessionFileStat,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

/** Leaf identity compared across the host-reopen window. mtime is excluded. */
function sameValidatedLeafIdentity(
  left: Pick<PiNativeSessionFileStat, "dev" | "ino" | "size">,
  right: Pick<PiNativeSessionFileStat, "dev" | "ino" | "size">,
): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.size === right.size
  );
}

function concatChunks(
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Opens `fileName` through the held no-follow directory and reads it whole
 * under {@link readBoundedFile} bounds. The descriptor is always closed.
 */
function readBoundedFileFromDirectory(
  directory: PiNativeSessionDirectory,
  fileName: string,
  ref: string,
  maxBytes: number,
): ResultAsync<Uint8Array | undefined, PiNativeSessionError> {
  return directory
    .openFile(fileName)
    .mapErr((error) => fromFsError(error, ref))
    .andThen((handle) => {
      if (handle === undefined) {
        return okAsync<Uint8Array | undefined, PiNativeSessionError>(void 0);
      }
      return readBoundedFile(handle, ref, maxBytes)
        .map((bytes): Uint8Array | undefined => {
          handle.close();
          return bytes;
        })
        .mapErr((error) => {
          handle.close();
          return error;
        });
    });
}

/**
 * Parses one native v3 session file from the exact bytes read through the
 * no-follow descriptor. The first line must be the session header, which is
 * validated against the expected parent link; body lines are parsed strictly,
 * and a corrupt or overlong line fails the whole read rather than yielding a
 * partial transcript.
 */
function parseSessionFileContents(
  bytes: Uint8Array,
  ref: string,
  expectedParentSession: string | undefined,
): Result<
  {
    readonly header: PiValidatedSessionHeader;
    readonly entries: readonly unknown[];
  },
  PiNativeSessionError
> {
  const corrupt = (
    reason: PiNativeSessionCorruption,
  ): PiNativeSessionError => ({
    type: "SessionCorrupt",
    ref,
    reason,
  });
  if (bytes.length === 0) return err(corrupt("missing-header"));

  const maxLine = effectivePiNativeSessionMaxRangeLength();
  const entries: unknown[] = [];
  let header: PiValidatedSessionHeader | undefined;
  let start = 0;
  while (start < bytes.length) {
    let end = bytes.indexOf(0x0a, start);
    if (end < 0) end = bytes.length;
    if (end - start > maxLine) return err(corrupt("line-too-long"));
    const line = bytes.subarray(start, end);
    start = end + 1;
    if (line.length === 0) {
      // A trailing newline is normal; an empty interior line is not.
      if (start >= bytes.length) break;
      return err(corrupt("unreadable"));
    }
    const parsed = parseJsonlBodyLine(0, line);
    if (parsed.kind !== "entry") return err(corrupt("unreadable"));
    if (header === undefined) {
      const validated = validateChildSessionHeader(
        parsed.value,
        expectedParentSession,
      );
      if (validated.isErr()) return err(corrupt(validated.error));
      header = validated.value;
      continue;
    }
    if (entries.length >= MAX_DESCRIPTOR_SESSION_ENTRIES) {
      return err(corrupt("unreadable"));
    }
    entries.push(parsed.value);
  }
  if (header === undefined) return err(corrupt("missing-header"));
  return ok({ header, entries });
}

/**
 * Wraps one already-authorized descriptor as the narrow line source a bounded
 * result scan runs on.
 *
 * This is the whole storage half of a durable result read. The descriptor was
 * resolved once through a held no-follow directory and its header identity was
 * already proven, so every line the scan ever sees comes from that one leaf.
 * The result protocol receives lines and offsets and nothing else: no path, no
 * directory, no way to reopen anything.
 *
 * Each page gets its own {@link PageScanState}, which is what keeps the
 * per-page ceilings in {@link PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS} per page
 * while the caller charges its own per-pass budget from `bytesRead`.
 */
function resultScanSource(
  handle: PiNativeSessionFileHandle,
  ref: string,
  identity: PiNativeSessionFileStat,
  headerEnd: number,
): PiNativeResultScanSource {
  const page = (
    located: readonly LocatedLine[],
    state: PageScanState,
  ): PiNativeResultScanPage => ({
    bytesRead: state.bytesRead,
    lines: located.map((line) => {
      const parsed = parseJsonlBodyLine(line.offset, line.bytes);
      const scanLine = {
        offset: line.offset,
        endOffset: line.offset + line.bytes.length,
      };
      return parsed.kind === "entry"
        ? { ...scanLine, entry: parsed.value }
        : scanLine;
    }),
  });
  return {
    ref,
    size: identity.size,
    headerEnd,
    leaf: { dev: identity.dev, ino: identity.ino },
    readBackward: (endExclusive, limit) => {
      const state: PageScanState = { bytesRead: 0, linesScanned: 0 };
      return readLinesBackward(
        handle,
        endExclusive,
        headerEnd,
        ref,
        state,
        identity,
        limit,
      ).map((located) => page(located, state));
    },
    readForward: (offset, limit) => {
      const state: PageScanState = { bytesRead: 0, linesScanned: 0 };
      return readLinesForward(
        handle,
        offset,
        identity.size,
        ref,
        state,
        identity,
        limit,
      ).map((located) => page(located, state));
    },
  };
}

/**
 * What one store proved about one session at the moment it returned a record.
 * Private to this module: no caller can read it, assert it, or construct it.
 */
interface ValidatedSessionFacts {
  readonly root: string;
  readonly ref: string;
  readonly sessionDir: string;
  readonly sessionPath: string;
  readonly sessionId: string;
  readonly parentSession: string | undefined;
  readonly header: PiValidatedSessionHeader;
}

/**
 * Storage-only manager for native Pi child sessions. Every fallible method
 * returns `ResultAsync` with {@link PiNativeSessionError}; nothing throws and
 * nothing writes outside the verified root.
 */
export class PiNativeSessionStore {
  private readonly root: string;
  private readonly fs: PiNativeSessionFsPort;
  private readonly host: PiNativeSessionHostPort;
  private readonly now: () => Date;
  private readonly launchAuthority: PiChildSessionLaunchAuthority | undefined;
  /**
   * Provenance for every record this store validated and returned.
   *
   * Keyed by object identity, so a caller-built record with identical fields
   * - the shape a public API consumer can trivially construct - carries no
   * entry and can never be turned into a launch grant. The stored facts, not
   * the caller's record, are what a grant is minted from.
   */
  private readonly provenance = new WeakMap<
    PiNativeSessionRecord,
    ValidatedSessionFacts
  >();

  constructor(options: PiNativeSessionStoreOptions) {
    this.root = options.root;
    this.fs = options.fs;
    this.host = options.host;
    this.now = options.now ?? (() => new Date());
    this.launchAuthority =
      options.launch.mode === "authorized"
        ? options.launch.authority
        : undefined;
  }

  /** Absolute session root this store is bound to. */
  sessionRoot(): string {
    return this.root;
  }

  /**
   * Records the facts this store proved about one session and freezes the
   * record it hands back. Only records that passed through here can be minted
   * into a launch grant.
   */
  private rememberValidatedRecord(
    record: PiNativeSessionRecord,
    header: PiValidatedSessionHeader,
  ): PiNativeSessionRecord {
    const frozen = Object.freeze({ ...record });
    const separator = frozen.path.lastIndexOf("/");
    this.provenance.set(frozen, {
      root: this.root,
      ref: frozen.ref,
      sessionDir: separator <= 0 ? "" : frozen.path.slice(0, separator),
      sessionPath: frozen.path,
      sessionId: header.id,
      parentSession: header.parentSession,
      header,
    });
    return frozen;
  }

  /**
   * Mints the unforgeable launch grant a child process needs to start against
   * this validated session (Spec 33 §5.3 / R5).
   *
   * Three independent proofs must hold, and none of them is supplied by the
   * caller:
   *
   * 1. **Provenance.** The presented record must be one this store itself
   *    validated and returned. A structural look-alike is refused before any
   *    filesystem or host call.
   * 2. **Freshness.** The proven ref is reopened through the no-follow
   *    directory and the host's own `SessionManager.open`, and the complete
   *    Pi v3 header is validated again. The reopened identity - session id,
   *    parent link, cwd, absolute path, ref - must equal the identity this
   *    store proved when it produced the record.
   * 3. **Authority.** This store must hold the generation-scoped launch
   *    authority, and that authority's validated root must be exactly this
   *    store's root.
   *
   * Only then is the grant minted, bound to the reopened directory, file,
   * ref, session id, the child id that will actually launch, the active leaf,
   * and the optional checkpoint cursor. Callers never hand a filesystem path
   * to a launch path; they hand this opaque grant.
   */
  mintLaunchGrant(
    input: MintNativeSessionLaunchGrantInput,
  ): ResultAsync<PiChildSessionLaunchGrant, PiNativeSessionError> {
    const authority = this.launchAuthority;
    if (authority === undefined) {
      return errAsync({
        type: "SessionGrantRefused",
        reason: "authority-unavailable",
      });
    }
    if (authority.sessionRoot !== this.root) {
      return errAsync({
        type: "SessionGrantRefused",
        reason: "authority-mismatch",
      });
    }
    const proven = this.provenance.get(input.record);
    if (proven === undefined || proven.root !== this.root) {
      return errAsync({
        type: "SessionGrantRefused",
        reason: "unproven-session",
      });
    }
    return this.openValidated(proven.ref, proven.parentSession).andThen(
      (reopened) => {
        const fresh = this.provenance.get(reopened.record);
        if (
          fresh === undefined ||
          fresh.sessionPath !== proven.sessionPath ||
          fresh.sessionDir !== proven.sessionDir ||
          fresh.sessionId !== proven.sessionId ||
          fresh.parentSession !== proven.parentSession ||
          !validatedHeadersMatch(fresh.header, proven.header)
        ) {
          return err<PiChildSessionLaunchGrant, PiNativeSessionError>({
            type: "SessionGrantRefused",
            reason: "identity-mismatch",
          });
        }
        const launchDetails =
          input.checkpointCursor === undefined
            ? {
                childId: input.childId,
                sessionId: fresh.sessionId,
                ref: fresh.ref,
                sessionDir: fresh.sessionDir,
                sessionPath: fresh.sessionPath,
                activeLeafId: input.activeLeafId,
              }
            : {
                childId: input.childId,
                sessionId: fresh.sessionId,
                ref: fresh.ref,
                sessionDir: fresh.sessionDir,
                sessionPath: fresh.sessionPath,
                activeLeafId: input.activeLeafId,
                checkpointCursor: input.checkpointCursor,
              };
        return mintPiChildSessionLaunchGrant(authority, launchDetails).mapErr(
          (): PiNativeSessionError => {
            // Every remaining rejection describes launch identity the store
            // derived itself; it never names a path.
            return {
              type: "SessionGrantRefused",
              reason: "invalid-launch-identity",
            };
          },
        );
      },
    );
  }

  /**
   * Creates and persists a child session *before* the child runs. The child
   * directory is created 0700 inside the verified root, the session is created
   * through the host's own `SessionManager.create(cwd, isolatedDir, options)`
   * with an immutable `parentSession` link, and when the host has not yet
   * flushed the generated path (Pi defers until an assistant entry), this
   * store exclusive-creates the host header line at 0600, reopens it, and
   * revalidates identity. A session that cannot be persisted fails closed -
   * never an ephemeral fallback, and never by fabricating header fields or
   * writing an assistant entry.
   */
  createChildSession(
    input: CreateNativeChildSessionInput,
  ): ResultAsync<PiNativeSessionRecord, PiNativeSessionError> {
    if (input.parentSession.length === 0) {
      return errAsync({
        type: "SessionCreateFailed",
        reason: "not-persisted",
      });
    }
    const component = safeNativeSessionComponent(input.childId);
    if (component.isErr()) return errAsync(component.error);
    const childDir = join(this.root, component.value);
    return withDirectory(
      this.fs,
      childDir,
      true,
      component.value,
      (directory) =>
        this.createInDirectory(input, component.value, childDir, directory),
    );
  }

  private createInDirectory(
    input: CreateNativeChildSessionInput,
    component: string,
    childDir: string,
    directory: PiNativeSessionDirectory,
  ): ResultAsync<PiNativeSessionRecord, PiNativeSessionError> {
    return Result.fromThrowable(
      () =>
        this.host.create(input.cwd, childDir, {
          parentSession: input.parentSession,
        }),
      (): PiNativeSessionError => ({
        type: "SessionCreateFailed",
        reason: "host-threw",
      }),
    )().asyncAndThen((handle) => {
      const identityResult = readHostSessionIdentity(handle);
      if (identityResult.isErr()) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>(
          identityResult.error,
        );
      }
      const identity = identityResult.value;
      const file = identity.sessionFile;
      if (!identity.persisted || file === undefined || file.length === 0) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionCreateFailed",
          reason: "not-persisted",
        });
      }
      // Containment is canonical immediate-child equality, never a prefix:
      // the returned leaf must live directly in the directory this store
      // opened and handed to Pi.
      if (!isImmediateChildPath(childDir, file)) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionRootViolation",
          reason: "path-escape",
        });
      }
      if (identity.sessionDir !== childDir) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionRootViolation",
          reason: "path-escape",
        });
      }
      const generated = persistableHostHeader(identity.header, input);
      if (generated.isErr() || identity.sessionId !== generated.value.id) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionCreateFailed",
          reason: "header-unusable",
        });
      }
      if (generated.value.cwd !== input.cwd) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionCreateFailed",
          reason: "header-unusable",
        });
      }
      const hostHeader = generated.value;
      const fileName = file.slice(file.lastIndexOf("/") + 1);
      const refResult = verifyNativeSessionRef(`${component}/${fileName}`);
      if (refResult.isErr()) return errAsync(refResult.error);
      const ref = refResult.value;
      return this.persistGeneratedHeader(
        directory,
        fileName,
        ref,
        hostHeader,
      ).andThen(() =>
        this.reopenCreatedSession(file, childDir, ref, input, hostHeader),
      );
    });
  }

  /**
   * When the host-generated path has no contained bytes yet (Pi defers the
   * first flush until an assistant entry), exclusive-create the header line
   * through the held no-follow directory. Occupied names fail as collision.
   */
  private persistGeneratedHeader(
    directory: PiNativeSessionDirectory,
    fileName: string,
    ref: string,
    hostHeader: PiValidatedSessionHeader,
  ): ResultAsync<void, PiNativeSessionError> {
    return directory
      .statFile(fileName)
      .mapErr((error) => this.mapCreateFsError(error, ref))
      .andThen((existing): ResultAsync<void, PiNativeSessionError> => {
        if (existing !== undefined) {
          return errAsync<undefined, PiNativeSessionError>({
            type: "SessionCreateFailed",
            reason: "collision",
          });
        }
        const line = headerLineEncoder.encode(
          `${JSON.stringify(hostHeader)}\n`,
        );
        return directory
          .createExclusiveFile(
            fileName,
            line,
            PI_NATIVE_SESSION_LAYOUT.fileMode,
          )
          .mapErr((error) => this.mapCreateFsError(error, ref))
          .andThen(() =>
            directory
              .statFile(fileName)
              .mapErr((error) => this.mapCreateFsError(error, ref))
              .andThen((stat) =>
                stat === undefined
                  ? errAsync<undefined, PiNativeSessionError>({
                      type: "SessionCreateFailed",
                      reason: "not-persisted",
                    })
                  : okAsync<undefined, PiNativeSessionError>(void 0),
              ),
          );
      });
  }

  private mapCreateFsError(
    error: PiNativeSessionFsError,
    ref: string,
  ): PiNativeSessionError {
    if (error.type === "already-exists") {
      return { type: "SessionCreateFailed", reason: "collision" };
    }
    if (error.type === "io" || error.type === "unavailable") {
      return { type: "SessionCreateFailed", reason: "io" };
    }
    if (error.type === "permissive-mode" || error.type === "foreign-owner") {
      return { type: "SessionPermissionError", kind: error.kind };
    }
    return fromFsError(error, ref);
  }

  /**
   * Reopens the exclusively persisted header through the host and proves the
   * on-disk identity still matches the generated header before spawn.
   */
  private reopenCreatedSession(
    path: string,
    childDir: string,
    ref: string,
    input: CreateNativeChildSessionInput,
    hostHeader: PiValidatedSessionHeader,
  ): ResultAsync<PiNativeSessionRecord, PiNativeSessionError> {
    return Result.fromThrowable(
      () => this.host.open(path, childDir),
      (): PiNativeSessionError => ({
        type: "SessionCreateFailed",
        reason: "host-threw",
      }),
    )().asyncAndThen((handle) => {
      const identityResult = readHostSessionIdentity(handle);
      if (identityResult.isErr()) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>(
          identityResult.error,
        );
      }
      const identity = identityResult.value;
      if (!identity.persisted) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionCreateFailed",
          reason: "not-persisted",
        });
      }
      if (identity.sessionFile !== path || identity.sessionDir !== childDir) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionRootViolation",
          reason: "path-escape",
        });
      }
      const reopened = persistableHostHeader(identity.header, input);
      if (
        reopened.isErr() ||
        !validatedHeadersMatch(hostHeader, reopened.value) ||
        identity.sessionId !== reopened.value.id
      ) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionCreateFailed",
          reason: "header-unusable",
        });
      }
      return okAsync<PiNativeSessionRecord, PiNativeSessionError>(
        this.rememberValidatedRecord(
          {
            childId: input.childId,
            sessionId: reopened.value.id,
            ref,
            path,
            parentSession: input.parentSession,
            cwd: reopened.value.cwd,
          },
          reopened.value,
        ),
      );
    });
  }

  /**
   * Opens one persisted child session by root-relative ref for read (live or
   * historical). Missing and corrupt sessions surface as typed errors the UI
   * maps to "unavailable + repair/remove"; they are never repaired here.
   */
  openSession(
    ref: string,
    expectedParentSession?: string,
  ): ResultAsync<PiNativeSessionRecord, PiNativeSessionError> {
    return this.openDescriptor(ref, expectedParentSession)
      .map(({ record }) => record)
      .orElse((error) =>
        // A session holding a retained result may legitimately exceed the
        // whole-session read ceiling. Identity lives in the header line, so
        // fall back to the bounded header read rather than reporting a
        // healthy large session as corrupt.
        isFileTooLarge(error)
          ? this.readSessionRecordFromHeader(ref, expectedParentSession)
          : errAsync(error),
      );
  }

  /**
   * Reads only the session header line through the bounded page reader and
   * builds the same record `openSession` returns. Bounded by one line, so it
   * stays available for sessions larger than the whole-session read ceiling.
   */
  private readSessionRecordFromHeader(
    ref: string,
    expectedParentSession: string | undefined,
  ): ResultAsync<PiNativeSessionRecord, PiNativeSessionError> {
    const located = this.locate(ref);
    if (located.isErr()) return errAsync(located.error);
    const { component, fileName, childDir, path, verified } = located.value;
    return withDirectory(this.fs, childDir, false, verified, (directory) =>
      directory
        .openFile(fileName)
        .mapErr((error) => fromFsError(error, verified))
        .andThen((handle) => {
          if (handle === undefined) {
            return errAsync<PiNativeSessionHeader, PiNativeSessionError>({
              type: "SessionMissing",
              ref: verified,
            });
          }
          return readSessionHeaderLine(handle, verified, expectedParentSession)
            .map((header) => {
              handle.close();
              return header;
            })
            .mapErr((error) => {
              handle.close();
              return error;
            });
        }),
    ).map((header) => ({
      childId: component,
      sessionId: header.id,
      ref: verified,
      path,
      parentSession: header.parentSession ?? "",
      cwd: header.cwd,
    }));
  }

  /**
   * Reads native entries for a live or historical child session straight from
   * the descriptor-verified session file. Validates the ref, presence,
   * header, and parent link, then parses the bounded v3 JSONL body without
   * copying transcript bytes into adapter storage. This path never calls
   * `SessionManager.create` / `open`, so history, doctor, list, show, and
   * thread-metadata reconstruction stay available on a host whose storage
   * authority preflight fails.
   */
  readSessionEntries(
    ref: string,
    expectedParentSession?: string,
  ): ResultAsync<PiNativeSessionEntries, PiNativeSessionError> {
    return this.openDescriptor(ref, expectedParentSession);
  }

  /**
   * Bounded native v3 JSONL entry page. Uses only `statFile` /
   * `readFileRange` in ≤64 KiB chunks — never `readFile`,
   * `readSessionEntries`, or `SessionManager.getEntries`.
   *
   * Directions:
   * - `newest`: newest body entries (header skipped), optional cursor ignored
   * - `older`: body entries strictly older than the opaque cursor
   * - `newer`: body entries strictly newer than the opaque cursor
   *
   * Stops at `limit` (≤100) or the fixed byte/line scan budgets, whichever
   * comes first. Corrupt lines are typed in-page; overlong lines fail closed.
   */
  readSessionEntryPage(
    ref: string,
    expectedParentSession: string | undefined,
    options: PiNativeSessionEntryPageOptions,
  ): ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError> {
    const verified = verifyNativeSessionRef(ref);
    if (verified.isErr()) return errAsync(verified.error);
    const limit = clampEntryPageLimit(options.limit);
    if (limit === 0) {
      return errAsync({
        type: "SessionCorrupt",
        ref: verified.value,
        reason: "unreadable",
      });
    }
    if (
      (options.direction === "older" || options.direction === "newer") &&
      (options.cursor === undefined || options.cursor.length === 0)
    ) {
      return errAsync({
        type: "SessionCorrupt",
        ref: verified.value,
        reason: "invalid-cursor",
      });
    }

    const separator = verified.value.lastIndexOf("/");
    if (separator <= 0) {
      return errAsync({ type: "SessionRootViolation", reason: "path-escape" });
    }
    const component = verified.value.slice(0, separator);
    const fileName = verified.value.slice(separator + 1);
    const childDir = join(this.root, component);

    return withDirectory(
      this.fs,
      childDir,
      false,
      verified.value,
      (directory) =>
        this.pageFromDirectory(
          directory,
          fileName,
          verified.value,
          expectedParentSession,
          options.direction,
          options.cursor,
          limit,
        ),
    );
  }

  /**
   * Opens the session file once through the held no-follow directory and pages
   * from that descriptor. The validated leaf is never reopened by name, so a
   * path swap after validation cannot redirect a single chunk.
   */
  private pageFromDirectory(
    directory: PiNativeSessionDirectory,
    fileName: string,
    ref: string,
    expectedParentSession: string | undefined,
    direction: PiNativeSessionEntryPageDirection,
    cursorToken: string | undefined,
    limit: number,
  ): ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError> {
    return directory
      .openFile(fileName)
      .mapErr((error) => fromFsError(error, ref))
      .andThen((handle) => {
        if (handle === undefined) {
          return errAsync<PiNativeSessionEntryPage, PiNativeSessionError>({
            type: "SessionMissing",
            ref,
          });
        }
        return this.pageFromHandle(
          handle,
          ref,
          expectedParentSession,
          direction,
          cursorToken,
          limit,
        )
          .map((page) => {
            handle.close();
            return page;
          })
          .mapErr((error) => {
            handle.close();
            return error;
          });
      });
  }

  private pageFromHandle(
    handle: PiNativeSessionFileHandle,
    ref: string,
    expectedParentSession: string | undefined,
    direction: PiNativeSessionEntryPageDirection,
    cursorToken: string | undefined,
    limit: number,
  ): ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError> {
    const state: PageScanState = { bytesRead: 0, linesScanned: 0 };
    return handle
      .stat()
      .mapErr((error) => fromFsError(error, ref))
      .andThen((identity) => {
        return this.validateHeaderFromFile(
          handle,
          ref,
          identity,
          state,
          expectedParentSession,
        ).andThen(({ headerEnd }) => {
          let decodedCursor: PiNativeSessionEntryCursor | undefined;
          if (cursorToken !== undefined && direction !== "newest") {
            const decoded = decodePiNativeSessionEntryCursor(cursorToken, ref);
            if (decoded.isErr()) return errAsync(decoded.error);
            const stale = cursorMatchesIdentity(decoded.value, identity);
            if (stale !== undefined) {
              return errAsync<PiNativeSessionEntryPage, PiNativeSessionError>({
                type: "SessionCorrupt",
                ref,
                reason: stale,
              });
            }
            if (decoded.value.offset < headerEnd) {
              return errAsync<PiNativeSessionEntryPage, PiNativeSessionError>({
                type: "SessionCorrupt",
                ref,
                reason: "invalid-cursor",
              });
            }
            decodedCursor = decoded.value;
          }

          if (direction === "newest") {
            return this.pageNewest(
              handle,
              ref,
              identity,
              state,
              headerEnd,
              limit,
            );
          }
          if (decodedCursor === undefined) {
            return errAsync<PiNativeSessionEntryPage, PiNativeSessionError>({
              type: "SessionCorrupt",
              ref,
              reason: "invalid-cursor",
            });
          }
          if (direction === "older") {
            return this.pageOlder(
              handle,
              ref,
              identity,
              state,
              headerEnd,
              decodedCursor,
              limit,
            );
          }
          if (direction === "at") {
            return this.pageAt(handle, ref, identity, state, decodedCursor);
          }
          return this.pageNewer(
            handle,
            ref,
            identity,
            state,
            decodedCursor,
            limit,
          );
        });
      });
  }

  private validateHeaderFromFile(
    handle: PiNativeSessionFileHandle,
    ref: string,
    identity: PiNativeSessionFileStat,
    state: PageScanState,
    expectedParentSession: string | undefined,
  ): ResultAsync<PiNativeSessionHeaderPosition, PiNativeSessionError> {
    if (identity.size === 0) {
      return errAsync({
        type: "SessionCorrupt",
        ref,
        reason: "missing-header",
      });
    }
    return readLinesForward(
      handle,
      0,
      // Header scan window stays at the production ceiling; only per-read
      // chunking uses the test override via effectivePiNativeSessionMaxRangeLength().
      Math.min(identity.size, PI_NATIVE_SESSION_MAX_RANGE_LENGTH),
      ref,
      state,
      identity,
      1,
    ).andThen((lines) => {
      const headerLine = lines[0];
      if (headerLine === undefined) {
        return errAsync<PiNativeSessionHeaderPosition, PiNativeSessionError>({
          type: "SessionCorrupt",
          ref,
          reason: "missing-header",
        });
      }
      const parsed = parseJsonlBodyLine(headerLine.offset, headerLine.bytes);
      if (parsed.kind !== "entry") {
        return errAsync<PiNativeSessionHeaderPosition, PiNativeSessionError>({
          type: "SessionCorrupt",
          ref,
          reason: "missing-header",
        });
      }
      // Paging validates the same complete header contract as every other
      // lifecycle path; a header good enough to page is good enough to open.
      const validated = validateChildSessionHeader(
        parsed.value,
        expectedParentSession,
      );
      if (validated.isErr()) {
        return errAsync<PiNativeSessionHeaderPosition, PiNativeSessionError>({
          type: "SessionCorrupt",
          ref,
          reason: validated.error,
        });
      }
      // Header line ends at first newline, or the whole file when absent.
      const headerEnd =
        headerLine.offset +
        headerLine.bytes.length +
        (headerLine.offset + headerLine.bytes.length < identity.size ? 1 : 0);
      return okAsync({
        headerEnd,
        sessionId: validated.value.id,
      });
    });
  }

  private buildPageResult(
    identity: PiNativeSessionFileStat,
    state: PageScanState,
    /** Oldest→newest body entries for this page. */
    entries: readonly PiNativeSessionPagedEntry[],
    hasOlder: boolean,
    hasNewer: boolean,
  ): Result<PiNativeSessionEntryPage, PiNativeSessionError> {
    const entriesWithCursors: PiNativeSessionPagedEntry[] = [];
    for (const entry of entries) {
      const encoded = encodePiNativeSessionEntryCursor({
        version: PI_NATIVE_SESSION_ENTRY_CURSOR_VERSION,
        dev: identity.dev,
        ino: identity.ino,
        size: identity.size,
        offset: entry.offset,
        anchor: "newer",
      });
      if (encoded.isErr()) return err(encoded.error);
      entriesWithCursors.push({ ...entry, cursor: encoded.value });
    }
    const oldest = entriesWithCursors[0];
    const newest = entriesWithCursors[entriesWithCursors.length - 1];
    let olderCursor: string | undefined;
    let newerCursor: string | undefined;
    if (hasOlder && oldest !== undefined) {
      const encoded = encodePiNativeSessionEntryCursor({
        version: PI_NATIVE_SESSION_ENTRY_CURSOR_VERSION,
        dev: identity.dev,
        ino: identity.ino,
        size: identity.size,
        offset: oldest.offset,
        anchor: "older",
      });
      if (encoded.isErr()) return err(encoded.error);
      olderCursor = encoded.value;
    }
    if (hasNewer && newest !== undefined) {
      const encoded = encodePiNativeSessionEntryCursor({
        version: PI_NATIVE_SESSION_ENTRY_CURSOR_VERSION,
        dev: identity.dev,
        ino: identity.ino,
        size: identity.size,
        offset: newest.offset,
        anchor: "newer",
      });
      if (encoded.isErr()) return err(encoded.error);
      newerCursor = encoded.value;
    }
    const basePage = {
      entries: entriesWithCursors,
      bytesRead: state.bytesRead,
      linesScanned: state.linesScanned,
    };
    if (olderCursor === undefined) {
      return newerCursor === undefined
        ? ok(basePage)
        : ok({ ...basePage, newerCursor });
    }
    return newerCursor === undefined
      ? ok({ ...basePage, olderCursor })
      : ok({ ...basePage, olderCursor, newerCursor });
  }

  private pageNewest(
    handle: PiNativeSessionFileHandle,
    ref: string,
    identity: PiNativeSessionFileStat,
    state: PageScanState,
    headerEnd: number,
    limit: number,
  ): ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError> {
    // Scan enough lines to fill the page plus detect whether older exists.
    return readLinesBackward(
      handle,
      identity.size,
      headerEnd,
      ref,
      state,
      identity,
      limit + 1,
    ).andThen((linesNewestFirst) => {
      const body = linesNewestFirst.filter((line) => line.offset >= headerEnd);
      const pageNewestFirst = body.slice(0, limit);
      const pageOldestFirst = [...pageNewestFirst].reverse();
      // Older state is a fact about the file, not about why this page ended.
      // Deriving it from the entry count alone would silently drop history
      // whenever the byte budget - not `limit` - closed the scan, which is the
      // normal case for large entries such as durable result chunks.
      const hasOlder = (pageOldestFirst[0]?.offset ?? headerEnd) > headerEnd;
      const entries = pageOldestFirst.map((line) =>
        parseJsonlBodyLine(line.offset, line.bytes),
      );
      // Anchor a newer cursor at the tip so a later append can be loaded.
      const hasNewer = entries.length > 0;
      return this.buildPageResult(
        identity,
        state,
        entries,
        hasOlder,
        hasNewer,
      ).asyncAndThen((page) => okAsync(page));
    });
  }

  private pageOlder(
    handle: PiNativeSessionFileHandle,
    ref: string,
    identity: PiNativeSessionFileStat,
    state: PageScanState,
    headerEnd: number,
    cursor: PiNativeSessionEntryCursor,
    limit: number,
  ): ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError> {
    return readLinesBackward(
      handle,
      cursor.offset,
      headerEnd,
      ref,
      state,
      identity,
      limit + 1,
    ).andThen((linesNewestFirst) => {
      const body = linesNewestFirst.filter(
        (line) => line.offset >= headerEnd && line.offset < cursor.offset,
      );
      const pageNewestFirst = body.slice(0, limit);
      const pageOldestFirst = [...pageNewestFirst].reverse();
      // Same rule as `pageNewest`: a budget-closed page still has older
      // entries, and must say so instead of ending the caller's walk.
      const hasOlder = (pageOldestFirst[0]?.offset ?? headerEnd) > headerEnd;
      const entries = pageOldestFirst.map((line) =>
        parseJsonlBodyLine(line.offset, line.bytes),
      );
      return this.buildPageResult(
        identity,
        state,
        entries,
        hasOlder,
        entries.length > 0,
      ).asyncAndThen((page) => okAsync(page));
    });
  }

  private pageAt(
    handle: PiNativeSessionFileHandle,
    ref: string,
    identity: PiNativeSessionFileStat,
    state: PageScanState,
    cursor: PiNativeSessionEntryCursor,
  ): ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError> {
    return readLinesForward(
      handle,
      cursor.offset,
      identity.size,
      ref,
      state,
      identity,
      1,
    ).andThen((lines) => {
      const line = lines[0];
      if (line === undefined || line.offset !== cursor.offset) {
        return errAsync<PiNativeSessionEntryPage, PiNativeSessionError>({
          type: "SessionCorrupt",
          ref,
          reason: "stale-cursor",
        });
      }
      return this.buildPageResult(
        identity,
        state,
        [parseJsonlBodyLine(line.offset, line.bytes)],
        false,
        false,
      ).asyncAndThen((page) => okAsync(page));
    });
  }

  private pageNewer(
    handle: PiNativeSessionFileHandle,
    ref: string,
    identity: PiNativeSessionFileStat,
    state: PageScanState,
    cursor: PiNativeSessionEntryCursor,
    limit: number,
  ): ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError> {
    return this.lineEndAfter(
      handle,
      ref,
      identity,
      state,
      cursor.offset,
    ).andThen((after) => {
      if (after >= identity.size) {
        return this.buildPageResult(
          identity,
          state,
          [],
          false,
          false,
        ).asyncAndThen((page) => okAsync(page));
      }
      return readLinesForward(
        handle,
        after,
        identity.size,
        ref,
        state,
        identity,
        limit + 1,
      ).andThen((lines) => {
        const hasNewer = lines.length > limit;
        const page = lines.slice(0, limit);
        const entries = page.map((line) =>
          parseJsonlBodyLine(line.offset, line.bytes),
        );
        return this.buildPageResult(
          identity,
          state,
          entries,
          entries.length > 0,
          hasNewer,
        ).asyncAndThen((result) => okAsync(result));
      });
    });
  }

  /** Byte offset immediately after the line that starts at `lineStart`. */
  private lineEndAfter(
    handle: PiNativeSessionFileHandle,
    ref: string,
    identity: PiNativeSessionFileStat,
    state: PageScanState,
    lineStart: number,
  ): ResultAsync<number, PiNativeSessionError> {
    if (lineStart >= identity.size) return okAsync(identity.size);
    const scanEnd = Math.min(
      identity.size,
      lineStart + PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes + 1,
    );
    return readLinesForward(
      handle,
      lineStart,
      scanEnd,
      ref,
      state,
      identity,
      1,
    ).andThen((lines) => {
      const first = lines[0];
      if (first === undefined) {
        return errAsync<number, PiNativeSessionError>({
          type: "SessionCorrupt",
          ref,
          reason: "invalid-cursor",
        });
      }
      if (first.offset !== lineStart) {
        return errAsync<number, PiNativeSessionError>({
          type: "SessionCorrupt",
          ref,
          reason: "invalid-cursor",
        });
      }
      const end =
        first.offset +
        first.bytes.length +
        (first.offset + first.bytes.length < identity.size ? 1 : 0);
      return okAsync(end);
    });
  }

  /**
   * Establishes the thread's active leaf by appending one bounded,
   * metadata-only thread entry to a freshly created child session, and
   * returns the leaf that entry became.
   *
   * A session that carries only a header has no leaf, so it could never be
   * reopened at a proven position. This writes the smallest possible real
   * entry - agent identity, model/reasoning intent, owner, and creation time,
   * never a task, response, or path - so every later run of the thread
   * reopens an authoritative leaf and can rebuild the thread's required state
   * from the session itself rather than from adapter memory.
   */
  establishThreadLeaf(
    ref: string,
    metadata: PiNativeThreadMetadataInput,
    expectedParentSession?: string,
  ): ResultAsync<
    { readonly record: PiNativeSessionRecord; readonly leafId: string },
    PiNativeSessionError
  > {
    const parsed = PiNativeThreadMetadataSchema.safeParse({
      ...metadata,
      schemaVersion: PI_NATIVE_THREAD_SCHEMA_VERSION,
    });
    if (!parsed.success) {
      return errAsync({ type: "SessionCreateFailed", reason: "io" });
    }
    const payload = parsed.data;
    return this.openValidated(ref, expectedParentSession).andThen(
      ({ record, handle }) => {
        const append = handle.appendCustomEntry?.bind(handle);
        if (append === undefined) {
          return errAsync<
            { readonly record: PiNativeSessionRecord; readonly leafId: string },
            PiNativeSessionError
          >({ type: "SessionCreateFailed", reason: "host-threw" });
        }
        return Result.fromThrowable(
          () => append(PI_NATIVE_THREAD_ENTRY_TYPE, payload),
          (): PiNativeSessionError => ({
            type: "SessionCreateFailed",
            reason: "host-threw",
          }),
        )().andThen((appended) => {
          const appendedLeafId = z.string().min(1).safeParse(appended);
          if (appendedLeafId.success) {
            return ok<
              {
                readonly record: PiNativeSessionRecord;
                readonly leafId: string;
              },
              PiNativeSessionError
            >({ record, leafId: appendedLeafId.data });
          }
          // The append gave no usable id, so fall back to the host's optional
          // leaf getter. That getter is host code and may throw, so it is
          // wrapped here rather than called bare: a throw becomes the same
          // typed, path-free session error as any other unreadable leaf, and
          // the caller's cleanup still runs.
          const readLeafId = handle.getLeafId?.bind(handle);
          const fallback: Result<
            string | null | undefined,
            PiNativeSessionError
          > =
            readLeafId === undefined
              ? ok(void 0)
              : Result.fromThrowable(
                  readLeafId,
                  (): PiNativeSessionError => ({
                    type: "SessionCorrupt",
                    ref: record.ref,
                    reason: "unreadable",
                  }),
                )();
          return fallback.andThen((leafId) => {
            const parsedLeafId = z.string().min(1).safeParse(leafId);
            if (!parsedLeafId.success) {
              return err<
                {
                  readonly record: PiNativeSessionRecord;
                  readonly leafId: string;
                },
                PiNativeSessionError
              >({
                type: "SessionCorrupt",
                ref: record.ref,
                reason: "unreadable",
              });
            }
            return ok<
              {
                readonly record: PiNativeSessionRecord;
                readonly leafId: string;
              },
              PiNativeSessionError
            >({ record, leafId: parsedLeafId.data });
          });
        });
      },
    );
  }

  /**
   * Appends complete terminal output to the authoritative native session in
   * bounded UTF-8 chunks. The opaque session ref remains the retrieval key;
   * raw output never enters Runtime Store, refs, logs, or telemetry.
   *
   * Identity, not just reachability, authorizes the write. The caller passes
   * the immutable child component, native session id, and origin parent it
   * provisioned, and every one of them must still hold on the reopened
   * session. A different child under the same parent is therefore refused
   * rather than silently given another child's authoritative result.
   *
   * Because the host append is path-backed, no check the writer performs can
   * by itself cover the write. So the writer does not decide acceptance: the
   * commit entry *carries* the identity it was authorized against, including
   * the `{dev,ino}` of the exact leaf observed under the held no-follow
   * directory before the first chunk landed, and every reader recomputes it.
   * A commit that reached a different leaf therefore names a leaf it is not
   * in, and no reader will ever accept that group.
   *
   * The write itself still fails closed as early as it can: all chunk
   * entries, then a re-verification of the leaf `{dev,ino}` and the live
   * session id, then the commit, then one final leaf check.
   */
  appendResultOutput(
    ref: string,
    output: string,
    expected: PiNativeResultAppendIdentity,
  ): ResultAsync<void, PiNativeSessionError> {
    const plan = planResultGroupWrite(output);
    if (plan.isErr()) return errAsync(plan.error);
    const located = this.locate(ref);
    if (located.isErr()) return errAsync(located.error);
    const { component, fileName, childDir, path, verified } = located.value;
    const expectedComponent = safeNativeSessionComponent(expected.childId);
    if (expectedComponent.isErr()) return errAsync(expectedComponent.error);
    if (component !== expectedComponent.value) {
      return errAsync({
        type: "SessionCorrupt",
        ref: verified,
        reason: "identity-mismatch",
      });
    }
    return withDirectory(this.fs, childDir, false, verified, (directory) =>
      this.statContainedLeaf(directory, fileName, verified).andThen(
        (validated) => {
          // The commit is bound to this exact leaf, observed under the held
          // no-follow directory before anything is written.
          const meta = bindResultGroupWriteMeta(plan.value, expected, {
            dev: validated.dev,
            ino: validated.ino,
          });
          return this.openHandle(
            path,
            childDir,
            component,
            verified,
            expected.parentSession,
          ).andThen(({ record, handle }) =>
            appendResultGroup({
              handle,
              record,
              expected,
              chunks: plan.value.chunks,
              meta,
              ref: verified,
              expectedChildComponent: expectedComponent.value,
              guards: {
                beforeChunks: () =>
                  this.requireUnchangedLeaf(
                    directory,
                    fileName,
                    verified,
                    validated,
                  ),
                // The chunks are on disk but not yet acceptable. Prove the
                // same leaf before the commit makes them readable.
                beforeCommit: () =>
                  this.requireSameLeafIdentity(
                    directory,
                    fileName,
                    verified,
                    validated,
                  ),
                afterCommit: () =>
                  this.requireSameLeafIdentity(
                    directory,
                    fileName,
                    verified,
                    validated,
                  ),
              },
            }),
          );
        },
      ),
    );
  }

  /**
   * Reads one durable result group through bounded pages.
   *
   * Never allocates the whole result: the group is streamed in ascending
   * chunk order, hashed incrementally, and only the optionally requested exact
   * content window is retained. A group is `complete` only after its chunk
   * count, order, byte total, and digest all match the commit record, so this
   * path can prove results up to the retained aggregate ceiling without any
   * whole-session read.
   *
   * Identity, not reachability, authorizes the read, and the authorization
   * covers every byte the read returns. The leaf is resolved by name exactly
   * once, and the whole read - header validation, the backward anchor pass,
   * and the forward verification pass - runs on that one open, identity-bound
   * descriptor. There is no reopen between pages, so a replacement after
   * authorization cannot redirect a later page: the held descriptor fails
   * closed instead, typed and without content.
   *
   * `expected` is the exact child, native session, and origin parent whose
   * result the caller asked for. All three are proven against the session's
   * own header before any scan, and against the commit record itself before
   * the group is accepted, together with the `{dev,ino}` of the authorized
   * descriptor. A sibling child of the same parent therefore never yields a
   * result, and a commit that reached some other leaf is never complete.
   *
   * The scan makes exactly {@link PI_NATIVE_RESULT_GROUP_BOUNDS.scanPasses}
   * passes, each with its own fresh page/byte budget derived from what paging
   * actually costs, so a group at the retained cap cannot exhaust a later
   * pass with bytes an earlier pass already spent.
   */
  readResultGroup(
    ref: string,
    expected: PiNativeResultReadIdentity,
    options: PiNativeResultGroupReadOptions = {},
  ): ResultAsync<PiNativeResultGroupRead, PiNativeSessionError> {
    const verified = verifyNativeSessionRef(ref);
    if (verified.isErr()) return errAsync(verified.error);
    const refValue = verified.value;
    const plan = prepareResultGroupRead(options, expected, refValue);
    if (plan.isErr()) return errAsync(plan.error);
    const located = this.locate(refValue);
    if (located.isErr()) return errAsync(located.error);
    const { component, fileName, childDir } = located.value;
    const expectedComponent = safeNativeSessionComponent(expected.childId);
    if (expectedComponent.isErr()) return errAsync(expectedComponent.error);
    if (component !== expectedComponent.value) {
      return errAsync({
        type: "SessionCorrupt",
        ref: refValue,
        reason: "identity-mismatch",
      });
    }
    const readPlan = plan.value;
    // One held no-follow directory, one name resolution, one descriptor. The
    // authorized leaf is the descriptor itself, so nothing downstream can read
    // a different file.
    return withDirectory(this.fs, childDir, false, refValue, (directory) =>
      directory
        .openFile(fileName)
        .mapErr((error) => fromFsError(error, refValue))
        .andThen((handle) => {
          if (handle === undefined) {
            return errAsync<PiNativeResultGroupRead, PiNativeSessionError>({
              type: "SessionMissing",
              ref: refValue,
            });
          }
          return this.readResultGroupFromHandle(
            handle,
            refValue,
            expected,
            readPlan,
          )
            .map((read) => {
              handle.close();
              return read;
            })
            .mapErr((error) => {
              handle.close();
              return error;
            });
        }),
    );
  }

  /**
   * Runs one whole bounded result read against a single authorized descriptor.
   *
   * The descriptor's own `{dev,ino}` *is* the authorization: it was resolved
   * through the held no-follow directory, and the port re-verifies both the
   * held descriptor and the directory leaf around every content read. Both
   * scan passes therefore read the same proven leaf by construction, and the
   * identity is checked once more after the scan, so a replacement anywhere
   * in the read window ends the read typed rather than returning content.
   *
   * Storage stops here. Once the header proves this descriptor is the exact
   * child, native session, and origin parent the caller asked for, the group
   * itself is proven by the result protocol over the narrow line source below.
   */
  private readResultGroupFromHandle(
    handle: PiNativeSessionFileHandle,
    ref: string,
    expected: PiNativeResultReadIdentity,
    plan: PiNativeResultGroupReadPlan,
  ): ResultAsync<PiNativeResultGroupRead, PiNativeSessionError> {
    const identity = handle.identity;
    const headerState: PageScanState = { bytesRead: 0, linesScanned: 0 };
    return this.validateHeaderFromFile(
      handle,
      ref,
      identity,
      headerState,
      expected.parentSession,
    )
      .andThen((header) =>
        header.sessionId === expected.nativeSessionId
          ? okAsync<PiNativeSessionHeaderPosition, PiNativeSessionError>(header)
          : errAsync<PiNativeSessionHeaderPosition, PiNativeSessionError>({
              type: "SessionCorrupt",
              ref,
              reason: "identity-mismatch",
            }),
      )
      .andThen((header) =>
        scanResultGroup(
          resultScanSource(handle, ref, identity, header.headerEnd),
          expected,
          plan,
        ),
      )
      .andThen((read) =>
        this.requireUnchangedDescriptor(handle, ref, identity).map(() => read),
      );
  }

  /**
   * Proves the descriptor the whole read ran on is still the exact file it was
   * authorized as. Metadata only; charges no scan budget.
   */
  private requireUnchangedDescriptor(
    handle: PiNativeSessionFileHandle,
    ref: string,
    authorized: PiNativeSessionFileStat,
  ): ResultAsync<void, PiNativeSessionError> {
    return handle
      .stat()
      .mapErr((error) => fromFsError(error, ref))
      .andThen((current) =>
        sameFileIdentity(current, authorized)
          ? okAsync<undefined, PiNativeSessionError>(void 0)
          : errAsync<undefined, PiNativeSessionError>({
              type: "SessionCorrupt",
              ref,
              reason: "identity-mismatch",
            }),
      );
  }

  /**
   * Re-stats the same contained name and fails closed unless the leaf is
   * still the same file. Size is allowed to grow, because an append-only
   * write is exactly what happens between the two observations.
   */
  private requireSameLeafIdentity(
    directory: PiNativeSessionDirectory,
    fileName: string,
    ref: string,
    expected: PiNativeSessionFileStat,
  ): ResultAsync<void, PiNativeSessionError> {
    return this.statContainedLeaf(directory, fileName, ref).andThen(
      (current) =>
        current.dev === expected.dev &&
        current.ino === expected.ino &&
        current.size >= expected.size
          ? okAsync<undefined, PiNativeSessionError>(void 0)
          : errAsync<undefined, PiNativeSessionError>({
              type: "SessionCorrupt",
              ref,
              reason: "identity-mismatch",
            }),
    );
  }

  /** No-follow leaf stat through the held directory. Missing leaves stay typed. */
  private statContainedLeaf(
    directory: PiNativeSessionDirectory,
    fileName: string,
    ref: string,
  ): ResultAsync<PiNativeSessionFileStat, PiNativeSessionError> {
    return directory
      .statFile(fileName)
      .mapErr((error) => fromFsError(error, ref))
      .andThen((stat) =>
        stat === undefined
          ? errAsync<PiNativeSessionFileStat, PiNativeSessionError>({
              type: "SessionMissing",
              ref,
            })
          : okAsync<PiNativeSessionFileStat, PiNativeSessionError>(stat),
      );
  }

  /**
   * Re-stats the same contained name and fails closed unless `{dev,ino,size}`
   * still match the identity captured before `host.open(path)`.
   */
  private requireUnchangedLeaf(
    directory: PiNativeSessionDirectory,
    fileName: string,
    ref: string,
    expected: PiNativeSessionFileStat,
  ): ResultAsync<void, PiNativeSessionError> {
    return this.statContainedLeaf(directory, fileName, ref).andThen(
      (current) =>
        sameValidatedLeafIdentity(current, expected)
          ? okAsync<undefined, PiNativeSessionError>(void 0)
          : errAsync<undefined, PiNativeSessionError>({
              type: "SessionCorrupt",
              ref,
              reason: "unreadable",
            }),
    );
  }

  /**
   * Reads the thread metadata a session was opened with. This is the
   * authoritative source a later generation reconstructs a thread from when
   * the adapter holds no in-memory state for it. A session without valid
   * thread metadata is reported as corrupt rather than guessed at.
   */
  readThreadMetadata(
    ref: string,
    expectedParentSession?: string,
  ): ResultAsync<PiNativeThreadMetadata, PiNativeSessionError> {
    return this.readSessionEntries(ref, expectedParentSession)
      .andThen(({ record, entries }) => {
        const metadata = readNativeThreadMetadata(entries);
        if (metadata === undefined) {
          return err<PiNativeThreadMetadata, PiNativeSessionError>({
            type: "SessionCorrupt",
            ref: record.ref,
            reason: "unreadable",
          });
        }
        return ok<PiNativeThreadMetadata, PiNativeSessionError>(metadata);
      })
      .orElse((error) =>
        // Restart recovery must still work for a session that retained a
        // large result, so an oversized session is paged instead of read
        // whole. Thread metadata is written once, near the oldest entries.
        isFileTooLarge(error)
          ? this.readThreadMetadataByPage(ref, expectedParentSession)
          : errAsync(error),
      );
  }

  /**
   * One budgeted page of the generic entry pager. Used by scans that walk a
   * session by opaque cursor rather than by a held descriptor; every page
   * charges the caller's pass budget.
   */
  private readResultScanPage(
    ref: string,
    expectedParentSession: string | undefined,
    options: PiNativeSessionEntryPageOptions,
    budget: PiNativeResultScanBudget,
  ): ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError> {
    budget.pages += 1;
    return this.readSessionEntryPage(ref, expectedParentSession, {
      ...options,
      limit: PI_NATIVE_RESULT_GROUP_BOUNDS.scanPageSize,
    }).map((page) => {
      budget.bytes += page.bytesRead;
      return page;
    });
  }

  /**
   * Bounded oldest-first scan for the newest thread metadata entry. Reads at
   * most {@link PI_NATIVE_RESULT_GROUP_BOUNDS} pages/bytes and never holds
   * more than one page.
   */
  private readThreadMetadataByPage(
    ref: string,
    expectedParentSession: string | undefined,
  ): ResultAsync<PiNativeThreadMetadata, PiNativeSessionError> {
    const budget: PiNativeResultScanBudget = { pages: 0, bytes: 0 };
    const step = (
      cursor: string | undefined,
      found: PiNativeThreadMetadata | undefined,
    ): ResultAsync<PiNativeThreadMetadata, PiNativeSessionError> => {
      if (exceedsResultScanBudget(budget)) {
        return found === undefined
          ? errAsync<PiNativeThreadMetadata, PiNativeSessionError>({
              type: "SessionCorrupt",
              ref,
              reason: "unreadable",
            })
          : okAsync(found);
      }
      return this.readResultScanPage(
        ref,
        expectedParentSession,
        cursor === undefined
          ? { direction: "newest" }
          : { direction: "older", cursor },
        budget,
      ).andThen((page) => {
        for (let index = page.entries.length - 1; index >= 0; index -= 1) {
          const entry = page.entries[index];
          if (entry === undefined || entry.kind !== "entry") continue;
          const metadata = readNativeThreadMetadata([entry.value]);
          if (metadata !== undefined) return okAsync(metadata);
        }
        if (page.olderCursor === undefined) {
          return errAsync<PiNativeThreadMetadata, PiNativeSessionError>({
            type: "SessionCorrupt",
            ref,
            reason: "unreadable",
          });
        }
        return step(page.olderCursor, found);
      });
    };
    return step(void 0, void 0);
  }

  /**
   * Shared descriptor-safe open path: open the session file once through the
   * no-follow port, read it in bounded chunks from that exact descriptor, then
   * validate header/parent and parse the bounded v3 JSONL body from those
   * exact bytes. The validated path is never reopened by name. No host call,
   * so this stays available when the host storage-authority preflight fails.
   */
  private openDescriptor(
    ref: string,
    expectedParentSession?: string,
  ): ResultAsync<PiNativeSessionEntries, PiNativeSessionError> {
    const located = this.locate(ref);
    if (located.isErr()) return errAsync(located.error);
    const { component, fileName, childDir, path, verified } = located.value;
    return withDirectory(this.fs, childDir, false, verified, (directory) =>
      readBoundedFileFromDirectory(
        directory,
        fileName,
        verified,
        PI_NATIVE_SESSION_MAX_FILE_BYTES,
      ).andThen((bytes) =>
        bytes === undefined
          ? errAsync<Uint8Array, PiNativeSessionError>({
              type: "SessionMissing",
              ref: verified,
            })
          : okAsync<Uint8Array, PiNativeSessionError>(bytes),
      ),
    ).andThen((bytes) =>
      parseSessionFileContents(bytes, verified, expectedParentSession).map(
        ({ header, entries }): PiNativeSessionEntries => ({
          record: this.rememberValidatedRecord(
            {
              childId: component,
              sessionId: header.id,
              ref: verified,
              path,
              parentSession: header.parentSession ?? "",
              cwd: header.cwd,
            },
            header,
          ),
          entries,
        }),
      ),
    );
  }

  /** Ref verification and containment, shared by descriptor and host paths. */
  private locate(ref: string): Result<
    {
      readonly verified: string;
      readonly component: string;
      readonly fileName: string;
      readonly childDir: string;
      readonly path: string;
    },
    PiNativeSessionError
  > {
    const verified = verifyNativeSessionRef(ref);
    if (verified.isErr()) return err(verified.error);
    const separator = verified.value.lastIndexOf("/");
    if (separator <= 0) {
      return err({ type: "SessionRootViolation", reason: "path-escape" });
    }
    const component = verified.value.slice(0, separator);
    const fileName = verified.value.slice(separator + 1);
    const childDir = join(this.root, component);
    return ok({
      verified: verified.value,
      component,
      fileName,
      childDir,
      path: join(childDir, fileName),
    });
  }

  /**
   * Host-backed open path, used only by operations that need a live handle
   * (thread leaf establishment). The storage-authority preflight runs before
   * the no-follow directory open, so a path-only host produces no filesystem
   * and no `SessionManager` side effect at all.
   */
  private openValidated(
    ref: string,
    expectedParentSession?: string,
  ): ResultAsync<
    {
      readonly record: PiNativeSessionRecord;
      readonly handle: PiNativeSessionHandle;
    },
    PiNativeSessionError
  > {
    const located = this.locate(ref);
    if (located.isErr()) return errAsync(located.error);
    const { component, fileName, childDir, path, verified } = located.value;
    return withDirectory(this.fs, childDir, false, verified, (directory) =>
      directory
        .statFile(fileName)
        .mapErr((error) => fromFsError(error, verified))
        .andThen((stat) =>
          stat === undefined
            ? errAsync<PiNativeSessionFileStat, PiNativeSessionError>({
                type: "SessionMissing",
                ref: verified,
              })
            : okAsync<PiNativeSessionFileStat, PiNativeSessionError>(stat),
        ),
    ).andThen(() =>
      this.openHandle(
        path,
        childDir,
        component,
        verified,
        expectedParentSession,
      ),
    );
  }

  private openHandle(
    path: string,
    childDir: string,
    component: string,
    ref: string,
    expectedParentSession: string | undefined,
  ): ResultAsync<
    {
      readonly record: PiNativeSessionRecord;
      readonly handle: PiNativeSessionHandle;
    },
    PiNativeSessionError
  > {
    return Result.fromThrowable(
      () => this.host.open(path, childDir),
      (): PiNativeSessionError => ({
        type: "SessionCorrupt",
        ref,
        reason: "unreadable",
      }),
    )().asyncAndThen((handle) => {
      type Opened = {
        readonly record: PiNativeSessionRecord;
        readonly handle: PiNativeSessionHandle;
      };
      const corrupt = (
        reason: PiNativeSessionCorruption,
      ): PiNativeSessionError => ({
        type: "SessionCorrupt",
        ref,
        reason,
      });
      const escaped: PiNativeSessionError = {
        type: "SessionRootViolation",
        reason: "path-escape",
      };
      // Every identity surface is read once, behind one throw boundary: a
      // getter that throws is a host failure, never a trusted answer.
      const identityResult = readHostSessionIdentity(handle, () =>
        corrupt("unreadable"),
      );
      if (identityResult.isErr()) return errAsync(identityResult.error);
      const identity = identityResult.value;
      // The reopen path validates the *complete* header contract, exactly as
      // create does: a host that reports a partial or exotic header on open
      // can never hand this store a record other code would then trust.
      const validated = validateChildSessionHeader(
        identity.header,
        expectedParentSession,
      );
      if (validated.isErr()) {
        return errAsync<Opened, PiNativeSessionError>(corrupt(validated.error));
      }
      // A host may not disagree with the identity this store already proved.
      // The reopened handle must name exactly the validated leaf, inside the
      // exact directory the ref resolved to, and report the same session id
      // as the header it just handed back.
      if (!identity.persisted) {
        return errAsync<Opened, PiNativeSessionError>(corrupt("not-persisted"));
      }
      const hostFile = identity.sessionFile;
      if (
        hostFile === undefined ||
        hostFile !== path ||
        identity.sessionDir !== childDir ||
        !isImmediateChildPath(childDir, hostFile)
      ) {
        return errAsync<Opened, PiNativeSessionError>(escaped);
      }
      if (identity.sessionId !== validated.value.id) {
        return errAsync<Opened, PiNativeSessionError>(corrupt("unreadable"));
      }
      return okAsync<Opened, PiNativeSessionError>({
        record: this.rememberValidatedRecord(
          {
            childId: component,
            sessionId: validated.value.id,
            ref,
            path,
            parentSession: validated.value.parentSession ?? "",
            cwd: validated.value.cwd,
          },
          validated.value,
        ),
        handle,
      });
    });
  }

  /**
   * Bounded list-by-ref. The caller supplies the refs (from parent entries);
   * this store never scans the tree, and never returns more than
   * `PI_NATIVE_SESSION_LAYOUT.maxListedSessions` states.
   */
  listByRef(
    refs: readonly string[],
    options: {
      readonly limit?: number;
      readonly expectedParentSession?: string;
    } = {},
  ): ResultAsync<readonly PiNativeSessionState[], never> {
    const limit = Math.max(
      0,
      Math.min(
        options.limit ?? PI_NATIVE_SESSION_LAYOUT.maxListedSessions,
        PI_NATIVE_SESSION_LAYOUT.maxListedSessions,
      ),
    );
    const selected = refs.slice(0, limit);
    return ResultAsync.fromSafePromise(
      Promise.all(
        selected.map((ref) =>
          this.openSession(ref, options.expectedParentSession).match(
            (record): PiNativeSessionState => ({ state: "available", record }),
            (error): PiNativeSessionState => {
              if (error.type === "SessionMissing")
                return { state: "missing", ref };
              if (error.type === "SessionCorrupt")
                return { state: "corrupt", ref, reason: error.reason };
              return { state: "unavailable", ref, error };
            },
          ),
        ),
      ),
    ).map((states): readonly PiNativeSessionState[] => states);
  }

  /**
   * Explicitly deletes one child session. The caller must echo the token from
   * {@link nativeSessionDeletionToken}. Durable visible deletion intent is
   * appended first; the native leaf is unlinked only after that record exists.
   * Unlink failure after intent is a typed recoverable pending/failed state,
   * never a completed tombstone while the session remains present.
   */
  deleteSession(
    record: PiNativeSessionRecord,
    confirmationToken: string,
  ): ResultAsync<PiNativeSessionTombstone, PiNativeSessionError> {
    if (confirmationToken !== nativeSessionDeletionToken(record.ref)) {
      return errAsync({
        type: "SessionConfirmationRequired",
        ref: record.ref,
      });
    }
    const located = this.locate(record.ref);
    if (located.isErr()) return errAsync(located.error);
    return this.acquireDeletionLock().andThen((lock) => {
      const operation = this.deleteLocatedSession(record, located.value);
      return new ResultAsync(
        Promise.resolve(operation).then((result) => {
          lock.release();
          return result;
        }),
      );
    });
  }

  private deleteLocatedSession(
    record: PiNativeSessionRecord,
    located: {
      readonly verified: string;
      readonly fileName: string;
      readonly childDir: string;
    },
  ): ResultAsync<PiNativeSessionTombstone, PiNativeSessionError> {
    return this.readDeletionLedger().andThen((ledger) => {
      const latest = latestDeletionForRef(ledger, located.verified);
      if (latest?.phase === "completed") {
        return this.unlinkNativeLeaf(located).andThen((unlinked) =>
          unlinked.isErr()
            ? errAsync(unlinked.error)
            : okAsync(asCompletedTombstone(latest)),
        );
      }
      const ensureIntent =
        latest === undefined
          ? this.requirePresentLeaf(located).andThen(() =>
              this.appendDeletionRecord(record, "intent"),
            )
          : okAsync(latest);
      return ensureIntent.andThen((current) =>
        this.syncDeletionLedger().andThen(() =>
          this.unlinkNativeLeaf(located).andThen(
            (
              unlinked,
            ): ResultAsync<PiNativeSessionTombstone, PiNativeSessionError> => {
              if (unlinked.isErr()) {
                const recordedFailed =
                  current.phase === "failed"
                    ? okAsync(current)
                    : this.appendDeletionRecord(record, "failed").orElse(() =>
                        okAsync(current),
                      );
                return recordedFailed.andThen(() => errAsync(unlinked.error));
              }
              return this.appendDeletionRecord(record, "completed").map(
                asCompletedTombstone,
              );
            },
          ),
        ),
      );
    });
  }

  private acquireDeletionLock(): ResultAsync<
    PiNativeSessionLock,
    PiNativeSessionError
  > {
    const acquire = async (): Promise<
      Result<PiNativeSessionLock, PiNativeSessionError>
    > => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const directoryResult = await this.fs.openDirectory(this.root, true);
        if (directoryResult.isErr()) {
          return err(fromFsError(directoryResult.error, "deletion-lock"));
        }
        const directory = directoryResult.value;
        const lockResult = await directory.tryExclusiveLock(
          ".session-deletion.lock",
        );
        directory.close();
        if (lockResult.isOk()) return ok(lockResult.value);
        if (lockResult.error.type !== "already-exists") {
          return err(mapTombstoneWriteError(lockResult.error));
        }
        await Bun.sleep(10);
      }
      return err({ type: "TombstoneAppendFailed", reason: "unavailable" });
    };
    return new ResultAsync(acquire());
  }

  private syncDeletionLedger(): ResultAsync<void, PiNativeSessionError> {
    return withDirectory(
      this.fs,
      this.root,
      true,
      PI_NATIVE_SESSION_LAYOUT.tombstoneFile,
      (directory) => directory.sync().mapErr(mapTombstoneWriteError),
    );
  }

  /**
   * Appends one completed tombstone record. Uses the port's append primitive
   * only, so prior records can never be rewritten or truncated by this module.
   * Callers that must not unlink a live session (failed provision) still use
   * this path; explicit user deletion goes through `deleteSession`.
   */
  appendTombstone(
    record: PiNativeSessionRecord,
  ): ResultAsync<PiNativeSessionTombstone, PiNativeSessionError> {
    return this.appendDeletionRecord(record, "completed").map(
      asCompletedTombstone,
    );
  }

  /** Reads every appended deletion record, newest last. Absent ledger reads empty. */
  readDeletionLedger(): ResultAsync<
    readonly PiNativeSessionDeletionRecord[],
    PiNativeSessionError
  > {
    return withDirectory(
      this.fs,
      this.root,
      false,
      PI_NATIVE_SESSION_LAYOUT.tombstoneFile,
      (directory) =>
        readBoundedFileFromDirectory(
          directory,
          PI_NATIVE_SESSION_LAYOUT.tombstoneFile,
          PI_NATIVE_SESSION_LAYOUT.tombstoneFile,
          PI_NATIVE_SESSION_MAX_FILE_BYTES,
        ).andThen((bytes) => parseDeletionLedger(bytes)),
    ).orElse((error) =>
      error.type === "SessionMissing"
        ? okAsync<
            readonly PiNativeSessionDeletionRecord[],
            PiNativeSessionError
          >([])
        : errAsync(error),
    );
  }

  /** Reads completed tombstones, newest last. Absent ledger reads empty. */
  readTombstones(): ResultAsync<
    readonly PiNativeSessionTombstone[],
    PiNativeSessionError
  > {
    return this.readDeletionLedger().map((records) =>
      records
        .filter((record) => record.phase === "completed")
        .map(asCompletedTombstone),
    );
  }

  private requirePresentLeaf(located: {
    readonly verified: string;
    readonly fileName: string;
    readonly childDir: string;
  }): ResultAsync<void, PiNativeSessionError> {
    return withDirectory(
      this.fs,
      located.childDir,
      false,
      located.verified,
      (directory) =>
        directory
          .statFile(located.fileName)
          .mapErr((error) => fromFsError(error, located.verified))
          .andThen((stat) =>
            stat === undefined
              ? errAsync<undefined, PiNativeSessionError>({
                  type: "SessionMissing",
                  ref: located.verified,
                })
              : okAsync<undefined, PiNativeSessionError>(void 0),
          ),
    );
  }

  private appendDeletionRecord(
    record: PiNativeSessionRecord,
    phase: PiNativeSessionDeletionPhase,
  ): ResultAsync<PiNativeSessionDeletionRecord, PiNativeSessionError> {
    const tombstone: PiNativeSessionDeletionRecord = {
      version: 1,
      ref: record.ref,
      childId: record.childId,
      parentSession: record.parentSession,
      deletedAt: this.now().toISOString(),
      reason: "explicit-user-deletion",
      phase,
    };
    const line = textEncoder.encode(`${JSON.stringify(tombstone)}\n`);
    return withDirectory(this.fs, this.root, true, record.ref, (directory) =>
      directory
        .statFile(PI_NATIVE_SESSION_LAYOUT.tombstoneFile)
        .mapErr(mapTombstoneWriteError)
        .andThen((before) =>
          directory
            .appendFile(
              PI_NATIVE_SESSION_LAYOUT.tombstoneFile,
              line,
              PI_NATIVE_SESSION_LAYOUT.fileMode,
            )
            .mapErr(mapTombstoneWriteError)
            .andThen(() =>
              before === undefined
                ? directory.sync().mapErr(mapTombstoneWriteError)
                : okAsync(void 0),
            ),
        )
        .map(() => tombstone),
    );
  }

  private unlinkNativeLeaf(located: {
    readonly verified: string;
    readonly fileName: string;
    readonly childDir: string;
  }): ResultAsync<Result<void, PiNativeSessionError>, PiNativeSessionError> {
    return withDirectory(
      this.fs,
      located.childDir,
      false,
      located.verified,
      (directory) =>
        directory
          .deleteFile(located.fileName)
          .mapErr((error) => mapUnlinkError(error, located.verified)),
    )
      .map(() => ok(void 0))
      .orElse((error) => {
        if (error.type === "SessionMissing") {
          return okAsync(ok(void 0));
        }
        if (error.type === "SessionUnlinkFailed") {
          return okAsync(err(error));
        }
        return errAsync(error);
      });
  }
}

function mapUnlinkError(
  error: PiNativeSessionFsError,
  ref: string,
): PiNativeSessionError {
  if (error.type === "permissive-mode") {
    return { type: "SessionUnlinkFailed", ref, reason: "permission" };
  }
  if (error.type === "unavailable") {
    return { type: "SessionUnlinkFailed", ref, reason: "unavailable" };
  }
  if (error.type === "missing") {
    return { type: "SessionMissing", ref };
  }
  if (
    error.type === "unsafe-path" ||
    error.type === "symlink-rejected" ||
    error.type === "relative-xdg-data-home" ||
    error.type === "empty-home"
  ) {
    return fromFsError(error, ref);
  }
  return { type: "SessionUnlinkFailed", ref, reason: "io" };
}

function mapTombstoneWriteError(
  error: PiNativeSessionFsError,
): PiNativeSessionError {
  if (error.type === "permissive-mode" || error.type === "foreign-owner") {
    return { type: "TombstoneAppendFailed", reason: "permission" };
  }
  if (error.type === "unavailable") {
    return { type: "TombstoneAppendFailed", reason: "unavailable" };
  }
  return { type: "TombstoneAppendFailed", reason: "io" };
}

function asCompletedTombstone(
  record: PiNativeSessionDeletionRecord,
): PiNativeSessionTombstone {
  return {
    version: 1,
    ref: record.ref,
    childId: record.childId,
    parentSession: record.parentSession,
    deletedAt: record.deletedAt,
    reason: "explicit-user-deletion",
    phase: "completed",
  };
}

function latestDeletionForRef(
  records: readonly PiNativeSessionDeletionRecord[],
  ref: string,
): PiNativeSessionDeletionRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.ref === ref) return record;
  }
  return undefined;
}

function parseDeletionLedger(
  bytes: Uint8Array | undefined,
): Result<readonly PiNativeSessionDeletionRecord[], PiNativeSessionError> {
  if (bytes === undefined) return ok([]);
  const text = new TextDecoder().decode(bytes);
  if (text.trim().length > 0 && !text.endsWith("\n")) {
    return err({
      type: "SessionCorrupt",
      ref: PI_NATIVE_SESSION_LAYOUT.tombstoneFile,
      reason: "unreadable",
    });
  }
  const records: PiNativeSessionDeletionRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = Result.fromThrowable(
      () => JSON.parse(line),
      () => void 0,
    )();
    if (parsed.isErr()) continue;
    const candidate = NativeSessionDeletionRecordSchema.safeParse(parsed.value);
    if (!candidate.success) continue;
    records.push({
      version: 1,
      ref: candidate.data.ref,
      childId: candidate.data.childId,
      parentSession: candidate.data.parentSession ?? "",
      deletedAt: candidate.data.deletedAt,
      reason: "explicit-user-deletion",
      phase: candidate.data.phase ?? "completed",
    });
  }
  return ok(records);
}
