/**
 * Wire-level contracts and hard limits of the Weave-owned native Pi session
 * tree (Spec 33, ADR 0014).
 *
 * This module holds no behaviour beyond mapping one closed failure set onto
 * another. It exists so that the session store
 * (`child-native-sessions.ts`) and the durable-result protocol
 * (`child-native-results.ts`) can share one definition of the failure
 * taxonomy, the injected no-follow filesystem boundary, the host session
 * boundary, and the read limits, instead of one module importing the other
 * and making the dependency circular.
 *
 * Every limit declared here is declared exactly once. A caller that needs a
 * ceiling imports it; it never restates it.
 */

import type { Result, ResultAsync } from "neverthrow";
import { Result as ResultCtor } from "neverthrow";
import { z } from "zod";

/**
 * Hard ceilings for one {@link PiNativeSessionStore.readSessionEntryPage}
 * call. Budgets are independent of total file size: a page never scans more
 * than these caps even when the transcript is much larger.
 */
export const PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS = Object.freeze({
  /** Hard ceiling on `limit` (and the default when omitted). */
  maxLimit: 100,
  /** Maximum bytes returned by `readFileRange` across one page call. */
  maxBytesScanned: 1024 * 1024,
  /** Maximum JSONL lines examined (including header skips and corrupt lines). */
  maxLinesScanned: 4_096,
  /**
   * Single-line ceiling; a longer line fails closed as `line-too-long`.
   * Kept below `maxBytesScanned` so an unterminated overlong line is
   * discovered inside one page budget rather than silently truncated.
   */
  maxLineBytes: 512 * 1024,
  /** Opaque cursor string ceiling. */
  maxCursorLength: 512,
});
// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why a path was refused before any session file was touched. */
export type PiNativeSessionRootViolation =
  | "empty-home"
  | "relative-xdg-data-home"
  /** The configured XDG base could not be canonicalized (loop/dangling/denied). */
  | "unresolvable-data-root"
  /** The canonical XDG base exists but is not a directory. */
  | "non-directory-data-root"
  /** The canonical XDG base is owned by another user. */
  | "foreign-data-root"
  /** The canonical XDG base is group- or world-writable. */
  | "writable-data-root"
  | "unsafe-component"
  | "path-escape"
  | "symlink-rejected";

/** Why a session file could not be interpreted as a Weave child session. */
export type PiNativeSessionCorruption =
  | "unreadable"
  | "missing-header"
  | "unsupported-version"
  | "parent-session-mismatch"
  | "not-persisted"
  | "invalid-cursor"
  | "stale-cursor"
  | "line-too-long"
  /**
   * The leaf or session this operation was authorized against is no longer
   * the leaf or session it is about to act on. Raised when an expected child
   * component, native session id, or `{dev,ino}` leaf identity stops matching
   * across an append window, so a substituted or replaced target fails closed
   * instead of receiving another child's authoritative result.
   */
  | "identity-mismatch"
  /**
   * The session file exceeds {@link PI_NATIVE_SESSION_MAX_FILE_BYTES}. Raised
   * from the opened descriptor's own size before any body byte is allocated,
   * or at the sentinel bound when metadata understated the real length.
   */
  | "file-too-large";

/** Closed failure set for every fallible operation in this module. */
export type PiNativeSessionError =
  | {
      readonly type: "SessionRootViolation";
      readonly reason: PiNativeSessionRootViolation;
    }
  | { readonly type: "SessionMissing"; readonly ref: string }
  | {
      readonly type: "SessionCorrupt";
      readonly ref: string;
      readonly reason: PiNativeSessionCorruption;
    }
  | {
      readonly type: "SessionPermissionError";
      readonly kind: "directory" | "file";
    }
  | {
      readonly type: "SessionCreateFailed";
      readonly reason:
        | "host-threw"
        | "not-persisted"
        | "io"
        /**
         * The generated session path was already occupied by bytes this store
         * did not write, or a concurrent writer landed on it between the
         * absence check and the exclusive create. Never repaired in place.
         */
        | "collision"
        /**
         * The host produced a header this store refuses to persist verbatim -
         * a wrong entry type/version, or a missing host-generated timestamp.
         * The store never fabricates header fields to work around this.
         */
        | "header-unusable";
    }
  | { readonly type: "SessionConfirmationRequired"; readonly ref: string }
  | {
      readonly type: "TombstoneAppendFailed";
      readonly reason: "io" | "unavailable" | "permission";
    }
  | {
      readonly type: "SessionUnlinkFailed";
      readonly ref: string;
      readonly reason: "io" | "unavailable" | "permission";
    }
  | {
      readonly type: "SessionStorageUnavailable";
      readonly reason: PiNativeSessionStorageUnavailableReason;
    };

/**
 * Why native session storage is unavailable. Bounded and path-free: a
 * diagnostic never carries a filesystem path, a prompt, or transcript bytes.
 */
export type PiNativeSessionStorageUnavailableReason = "filesystem-unavailable";

/** Human-readable, path-free description of a storage-unavailable reason. */
export function describePiNativeSessionStorageUnavailable(
  _reason: PiNativeSessionStorageUnavailableReason,
): string {
  return "native session storage is unavailable";
}

/** Storage-unavailable failure retained for typed filesystem boundaries. */
export type PiNativeSessionStorageUnavailable = Extract<
  PiNativeSessionError,
  { readonly type: "SessionStorageUnavailable" }
>;

// ---------------------------------------------------------------------------
// Injected no-follow filesystem port
// ---------------------------------------------------------------------------

/**
 * Closed failure set for the injected no-follow filesystem. Structural only:
 * any port that returns these discriminants satisfies the store, including
 * an in-memory fake used by tests.
 */
export type PiNativeSessionFsError =
  | { readonly type: "relative-xdg-data-home" }
  | { readonly type: "empty-home" }
  | { readonly type: "unsafe-path" }
  | {
      readonly type: "unavailable";
      readonly operation: "open" | "read" | "write" | "delete" | "quarantine";
    }
  | { readonly type: "missing" }
  | { readonly type: "symlink-rejected" }
  | { readonly type: "identity-changed" }
  | { readonly type: "invalid-range" }
  | { readonly type: "permissive-mode"; readonly kind: "directory" | "file" }
  | { readonly type: "wrong-kind"; readonly kind: "directory" | "file" }
  /**
   * Exclusive create lost a race: the leaf appeared between the absence check
   * and `O_EXCL`, or already occupied the name. Callers map this to collision.
   */
  | { readonly type: "already-exists" }
  | { readonly type: "io" };

/**
 * Maximum `readFileRange` length. Callers page through larger files with
 * repeated bounded reads; a single call never exceeds this budget.
 */
export const PI_NATIVE_SESSION_MAX_RANGE_LENGTH = 64 * 1024;

/**
 * Optional test-only ceiling used by paging scans. Production always uses
 * {@link PI_NATIVE_SESSION_MAX_RANGE_LENGTH}. Values above the production
 * ceiling are clamped; `undefined` clears the override.
 */
let piNativeSessionMaxRangeLengthForTests: number | undefined;

/** Sets or clears the test-only `readFileRange` chunk ceiling for paging. */
export function setPiNativeSessionMaxRangeLengthForTests(
  length: number | undefined,
): void {
  if (length === undefined) {
    piNativeSessionMaxRangeLengthForTests = undefined;
    return;
  }
  piNativeSessionMaxRangeLengthForTests = Math.max(
    1,
    Math.min(Math.floor(length), PI_NATIVE_SESSION_MAX_RANGE_LENGTH),
  );
}

/** The chunk ceiling paging scans must use: production value or override. */
export function effectivePiNativeSessionMaxRangeLength(): number {
  return (
    piNativeSessionMaxRangeLengthForTests ?? PI_NATIVE_SESSION_MAX_RANGE_LENGTH
  );
}

/**
 * Hard ceiling on the bytes one descriptor-safe whole-file session read may
 * allocate. Enforced against the opened descriptor's own size before any body
 * byte is read, and again as a sentinel bound while chunks accumulate, so a
 * hostile or corrupt file can never drive unbounded allocation.
 */
export const PI_NATIVE_SESSION_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Stable regular-file identity used by bounded range reads. */
export interface PiNativeSessionFileStat {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  /**
   * Last-modification time in milliseconds when the platform exposes it.
   * Compared alongside `{dev,ino,size}` so an in-place same-size rewrite
   * during a read is still detected.
   */
  readonly mtimeMs?: number;
}

/** One exact positional chunk plus the identity observed for that read. */
export interface PiNativeSessionFileRange {
  readonly identity: PiNativeSessionFileStat;
  readonly bytes: Uint8Array;
  readonly offset: number;
}

/**
 * One open, identity-bound regular-file descriptor under a verified session
 * directory. The handle captures `{dev,ino,size,mtimeMs}` at open time; every
 * read re-verifies that identity against the same descriptor and fails closed
 * on growth, truncation, replacement, or in-place mutation.
 */
export interface PiNativeSessionFileHandle {
  /** Identity observed when the descriptor was opened. */
  readonly identity: PiNativeSessionFileStat;
  /** Current descriptor identity; diverging from {@link identity} fails closed. */
  stat(): ResultAsync<PiNativeSessionFileStat, PiNativeSessionFsError>;
  /**
   * Positional read from the open descriptor. `offset`/`length` must be
   * nonnegative safe integers with
   * `length <= PI_NATIVE_SESSION_MAX_RANGE_LENGTH`. Performs at most one OS
   * content read surrounded by held-fd and descriptor-relative leaf checks.
   * Returns exact bytes (possibly short at EOF or when the OS short-reads)
   * bound to the identity captured at open. Callers resume short reads with
   * another `readRange` so every content read is fully re-checked.
   */
  readRange(
    offset: number,
    length: number,
  ): ResultAsync<PiNativeSessionFileRange, PiNativeSessionFsError>;
  close(): void;
}

/** One no-follow directory handle opened under the verified session root. */
export interface PiNativeSessionLock {
  release(): void;
}

export interface PiNativeSessionDirectory {
  readonly path: string;
  /**
   * Opens one regular 0600 leaf through the held no-follow directory and
   * returns a descriptor-bound handle. Every subsequent read comes from that
   * open descriptor, so the validated file can never be reopened by name and
   * a post-validation path swap cannot redirect reads. Missing leaves return
   * `undefined`; symlinks and non-files fail closed.
   */
  openFile(
    name: string,
  ): ResultAsync<PiNativeSessionFileHandle | undefined, PiNativeSessionFsError>;
  /**
   * No-follow `fstat` of a regular 0600 leaf. Missing leaves return
   * `undefined`; symlinks and non-files fail closed.
   */
  statFile(
    name: string,
  ): ResultAsync<PiNativeSessionFileStat | undefined, PiNativeSessionFsError>;
  /**
   * No-follow positional read via `pread`. `offset`/`length` must be
   * nonnegative safe integers with `length <= PI_NATIVE_SESSION_MAX_RANGE_LENGTH`.
   * Returns exact bytes (possibly short at EOF) bound to the observed
   * `{dev,ino,size}` identity; mid-read replace/truncate fails closed.
   */
  readFileRange(
    name: string,
    offset: number,
    length: number,
  ): ResultAsync<PiNativeSessionFileRange | undefined, PiNativeSessionFsError>;
  appendFile(
    name: string,
    bytes: Uint8Array,
    mode: number,
  ): ResultAsync<void, PiNativeSessionFsError>;
  /** Flushes directory-entry changes made through this held descriptor. */
  sync(): ResultAsync<void, PiNativeSessionFsError>;
  /** Tries to acquire a process-shared advisory lock on a safe root leaf. */
  tryExclusiveLock(
    name: string,
  ): ResultAsync<PiNativeSessionLock, PiNativeSessionFsError>;
  /**
   * Exclusive no-follow create of a new 0600 leaf. Fails with
   * {@link PiNativeSessionFsError} `already-exists` when the name is taken;
   * never truncates or appends to an existing leaf.
   */
  createExclusiveFile(
    name: string,
    bytes: Uint8Array,
    mode: number,
  ): ResultAsync<void, PiNativeSessionFsError>;
  deleteFile(name: string): ResultAsync<void, PiNativeSessionFsError>;
  close(): void;
}

/**
 * Injected no-follow filesystem boundary for the native session tree.
 * Production wires a libc `openat(O_NOFOLLOW)` implementation; tests supply
 * a structural in-memory fake.
 */
export interface PiNativeSessionFsPort {
  openDirectory(
    path: string,
    create: boolean,
  ): ResultAsync<PiNativeSessionDirectory, PiNativeSessionFsError>;
}

/** Maps one injected-filesystem failure onto this module's closed failure set. */
export function fromFsError(
  error: PiNativeSessionFsError,
  ref: string,
): PiNativeSessionError {
  switch (error.type) {
    case "unsafe-path":
      return { type: "SessionRootViolation", reason: "path-escape" };
    case "symlink-rejected":
      return { type: "SessionRootViolation", reason: "symlink-rejected" };
    case "relative-xdg-data-home":
      return { type: "SessionRootViolation", reason: "relative-xdg-data-home" };
    case "empty-home":
      return { type: "SessionRootViolation", reason: "empty-home" };
    case "missing":
      return { type: "SessionMissing", ref };
    case "permissive-mode":
      return { type: "SessionPermissionError", kind: error.kind };
    case "wrong-kind":
      return { type: "SessionCorrupt", ref, reason: "unreadable" };
    case "identity-changed":
      return { type: "SessionCorrupt", ref, reason: "unreadable" };
    case "invalid-range":
      return { type: "SessionCorrupt", ref, reason: "unreadable" };
    case "unavailable":
      return {
        type: "SessionStorageUnavailable",
        reason: "filesystem-unavailable",
      };
    default:
      return { type: "SessionCorrupt", ref, reason: "unreadable" };
  }
}
// ---------------------------------------------------------------------------
// Host session port
// ---------------------------------------------------------------------------

/** Header fields this module reads from a native Pi v3 session. */
export interface PiNativeSessionHeader {
  readonly id: string;
  readonly cwd: string;
  /** Native entry discriminator; Pi always emits `"session"`. */
  readonly type?: string;
  readonly version?: number;
  /** Host-generated ISO-8601 creation timestamp. Never synthesized here. */
  readonly timestamp?: string;
  readonly parentSession?: string;
}

/**
 * The narrow slice of Pi's `SessionManager` instance this module depends on.
 * Nothing here mutates a session; appends belong to the delegation runtime.
 */
export interface PiNativeSessionHandle {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionDir(): string;
  getHeader(): PiNativeSessionHeader | null;
  getEntries(): readonly unknown[];
  isPersisted(): boolean;
  /**
   * Current native leaf id, when the host exposes one. A session whose host
   * cannot report a leaf can still be read; it simply cannot be reopened at a
   * proven leaf, which the delegation runtime refuses rather than guesses.
   */
  getLeafId?(): string | null;
  /**
   * Appends one bounded, metadata-only custom entry and advances the leaf.
   * Optional because reading a session never needs it; the thread runtime
   * uses it once, at thread creation, to establish a real active leaf.
   */
  appendCustomEntry?(customType: string, data?: unknown): string;
}

/**
 * Host boundary over Pi's static session constructors. Production wires
 * `SessionManager.create(cwd, isolatedDir, options)` and
 * `SessionManager.open(path, sessionDir)`; tests script it.
 */
export interface PiNativeSessionHostPort {
  create(
    cwd: string,
    sessionDir: string,
    options: { readonly parentSession?: string; readonly id?: string },
  ): PiNativeSessionHandle;
  open(path: string, sessionDir: string): PiNativeSessionHandle;
}
/** One persisted child session, identified by its root-relative ref. */
export interface PiNativeSessionRecord {
  /** Opaque Weave child id supplied by the caller. */
  readonly childId: string;
  /** Native Pi session id from the session header. */
  readonly sessionId: string;
  /** Root-relative reference, always contained by the session root. */
  readonly ref: string;
  /** Absolute session file path. */
  readonly path: string;
  /** Immutable parent session link written into the session header. */
  readonly parentSession: string;
  /** Working directory recorded in the session header. */
  readonly cwd: string;
}

// ---------------------------------------------------------------------------
// Shared bounded encodings
// ---------------------------------------------------------------------------

/**
 * Ceiling every bounded identity or name field in a native session record and
 * in the durable-result protocol is validated against. Declared once so the
 * store and the result protocol cannot drift apart on what "bounded" means.
 */
export const PiNativeBoundedNameSchema = z.string().min(1).max(256);

/** Encodes bytes as an unpadded base64url string for opaque cursors. */
export function encodeNativeSessionBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

/** Decodes an unpadded base64url cursor string; malformed input stays typed. */
export function decodeNativeSessionBase64Url(
  value: string,
): Result<Uint8Array, undefined> {
  return ResultCtor.fromThrowable(
    () => {
      const padded = value.replace(/-/g, "+").replace(/_/g, "/");
      const padLength = (4 - (padded.length % 4)) % 4;
      const binary = atob(padded + "=".repeat(padLength));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    },
    () => undefined,
  )();
}
