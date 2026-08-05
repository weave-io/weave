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
 * reads live/historical native entries through the host, and explicitly
 * deletes child sessions. It does not render, does not own parent
 * custom-entry refs (Task 5), does not cache (Task 6), does not prune, and
 * never falls back to an ephemeral `--no-session` child: a persistence
 * failure is returned as an error *before* the child task starts. Entry
 * reads return host `getEntries()` output only; transcript bytes are never
 * copied into adapter storage.
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
import { isLexicallyContained } from "./path-containment.js";

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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why a path was refused before any session file was touched. */
export type PiNativeSessionRootViolation =
  | "empty-home"
  | "relative-xdg-data-home"
  | "unsafe-component"
  | "path-escape"
  | "symlink-rejected";

/** Why a session file could not be interpreted as a Weave child session. */
export type PiNativeSessionCorruption =
  | "unreadable"
  | "missing-header"
  | "unsupported-version"
  | "parent-session-mismatch"
  | "not-persisted";

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
      readonly reason: "host-threw" | "not-persisted" | "io";
    }
  | { readonly type: "SessionConfirmationRequired"; readonly ref: string }
  | {
      readonly type: "TombstoneAppendFailed";
      readonly reason: "io" | "unavailable" | "permission";
    }
  | { readonly type: "SessionStorageUnavailable" };

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
  | { readonly type: "permissive-mode"; readonly kind: "directory" | "file" }
  | { readonly type: "wrong-kind"; readonly kind: "directory" | "file" }
  | { readonly type: "io" };

/** One no-follow directory handle opened under the verified session root. */
export interface PiNativeSessionDirectory {
  readonly path: string;
  readFile(
    name: string,
  ): ResultAsync<Uint8Array | undefined, PiNativeSessionFsError>;
  appendFile(
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

function fromFsError(
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
    case "unavailable":
      return { type: "SessionStorageUnavailable" };
    default:
      return { type: "SessionCorrupt", ref, reason: "unreadable" };
  }
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

export interface PiNativeSessionRootInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}

/**
 * Resolves the fixed session root. `XDG_DATA_HOME` wins when set and absolute;
 * a relative `XDG_DATA_HOME` is a root violation rather than a silently
 * re-based path.
 */
export function resolvePiNativeSessionRoot(
  input: PiNativeSessionRootInput = {},
): Result<string, PiNativeSessionError> {
  const env = input.env ?? Bun.env;
  const home = input.homeDir ?? env.HOME ?? "";
  const configured = env.XDG_DATA_HOME;
  if (configured !== undefined && configured.length > 0) {
    if (!isAbsolute(configured)) {
      return err({
        type: "SessionRootViolation",
        reason: "relative-xdg-data-home",
      });
    }
    return ok(join(configured, ...PI_NATIVE_SESSION_LAYOUT.segments));
  }
  if (home.length === 0) {
    return err({ type: "SessionRootViolation", reason: "empty-home" });
  }
  return ok(
    join(home, ".local", "share", ...PI_NATIVE_SESSION_LAYOUT.segments),
  );
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
// Host session port
// ---------------------------------------------------------------------------

/** Header fields this module reads from a native Pi v3 session. */
export interface PiNativeSessionHeader {
  readonly id: string;
  readonly cwd: string;
  readonly version?: number;
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

// ---------------------------------------------------------------------------
// Records and states
// ---------------------------------------------------------------------------

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

/**
 * Validated session metadata plus host `getEntries()` output. Entries are
 * returned by reference from the host handle; this module never persists or
 * duplicates transcript bytes into adapter files.
 */
export interface PiNativeSessionEntries {
  readonly record: PiNativeSessionRecord;
  readonly entries: readonly unknown[];
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

/** Append-only deletion record. */
export interface PiNativeSessionTombstone {
  readonly version: 1;
  readonly ref: string;
  readonly childId: string;
  readonly parentSession: string;
  readonly deletedAt: string;
  readonly reason: "explicit-user-deletion";
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

export interface PiNativeSessionStoreOptions {
  readonly root: string;
  readonly fs: PiNativeSessionFsPort;
  readonly host: PiNativeSessionHostPort;
  readonly now?: () => Date;
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

const BOUNDED_NAME = z.string().min(1).max(256);

/**
 * The bounded, metadata-only state a thread must be able to rebuild from its
 * own authoritative session: who ran it, under whom, where, and with which
 * model intent. It carries no task text, no response, and no filesystem path.
 */
export const PiNativeThreadMetadataSchema = z
  .object({
    schemaVersion: z.literal(PI_NATIVE_THREAD_SCHEMA_VERSION),
    threadId: BOUNDED_NAME,
    agentName: BOUNDED_NAME,
    parentId: BOUNDED_NAME,
    parentAgentName: BOUNDED_NAME,
    parentDepth: z.number().int().min(0).max(64),
    ownerParentSessionId: BOUNDED_NAME,
    cwd: z.string().min(1).max(4_096),
    model: BOUNDED_NAME.optional(),
    reasoning: BOUNDED_NAME.optional(),
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

const NativeThreadEntryShapeSchema = z.looseObject({
  type: z.string().optional(),
  customType: z.string().optional(),
  data: z.unknown(),
});

/**
 * Finds the newest valid thread metadata entry in a native session's entries.
 * Malformed or foreign entries are ignored, never repaired; an absence is
 * reported to the caller as an absence.
 */
export function readNativeThreadMetadata(
  entries: readonly unknown[],
): PiNativeThreadMetadata | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const shape = NativeThreadEntryShapeSchema.safeParse(entries[index]);
    if (!shape.success) continue;
    if (shape.data.customType !== PI_NATIVE_THREAD_ENTRY_TYPE) continue;
    const parsed = PiNativeThreadMetadataSchema.safeParse(shape.data.data);
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

function headerCorruption(
  header: PiNativeSessionHeader | null,
  expectedParent: string | undefined,
): PiNativeSessionCorruption | undefined {
  if (
    header === null ||
    typeof header.id !== "string" ||
    header.id.length === 0
  )
    return "missing-header";
  if (header.version !== undefined && header.version !== 3)
    return "unsupported-version";
  if (
    expectedParent !== undefined &&
    header.parentSession !== undefined &&
    header.parentSession !== expectedParent
  ) {
    return "parent-session-mismatch";
  }
  if (header.parentSession === undefined) return "parent-session-mismatch";
  return undefined;
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

  constructor(options: PiNativeSessionStoreOptions) {
    this.root = options.root;
    this.fs = options.fs;
    this.host = options.host;
    this.now = options.now ?? (() => new Date());
  }

  /** Absolute session root this store is bound to. */
  sessionRoot(): string {
    return this.root;
  }

  /**
   * Creates and persists a child session *before* the child runs. The child
   * directory is created 0700 inside the verified root, the session is created
   * through the host's own `SessionManager.create(cwd, isolatedDir, options)`
   * with an immutable `parentSession` link, and a session that did not persist
   * is an error - never an ephemeral fallback.
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
    return withDirectory(this.fs, childDir, true, component.value, () =>
      this.createInDirectory(input, component.value, childDir),
    );
  }

  private createInDirectory(
    input: CreateNativeChildSessionInput,
    component: string,
    childDir: string,
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
      const file = handle.getSessionFile();
      if (!handle.isPersisted() || file === undefined || file.length === 0) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionCreateFailed",
          reason: "not-persisted",
        });
      }
      const header = handle.getHeader();
      const corruption = headerCorruption(header, input.parentSession);
      if (corruption !== undefined || header === null) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionCorrupt",
          ref: component,
          reason: corruption ?? "missing-header",
        });
      }
      const fileName = file.slice(file.lastIndexOf("/") + 1);
      const refResult = verifyNativeSessionRef(`${component}/${fileName}`);
      if (refResult.isErr()) return errAsync(refResult.error);
      const ref = refResult.value;
      if (!file.startsWith(`${childDir}/`)) {
        return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
          type: "SessionRootViolation",
          reason: "path-escape",
        });
      }
      return this.verifyFileMode(childDir, fileName, ref).map(() => ({
        childId: input.childId,
        sessionId: header.id,
        ref,
        path: file,
        parentSession: input.parentSession,
        cwd: header.cwd,
      }));
    });
  }

  /**
   * Proves the created session file exists with 0600 through the no-follow
   * port. A permissive or symlinked file fails closed instead of being
   * repaired in place.
   */
  private verifyFileMode(
    childDir: string,
    fileName: string,
    ref: string,
  ): ResultAsync<void, PiNativeSessionError> {
    return withDirectory(this.fs, childDir, false, ref, (directory) =>
      directory
        .readFile(fileName)
        .mapErr((error) => fromFsError(error, ref))
        .andThen((bytes) =>
          bytes === undefined
            ? errAsync<void, PiNativeSessionError>({
                type: "SessionCreateFailed",
                reason: "not-persisted",
              })
            : okAsync<void, PiNativeSessionError>(undefined),
        ),
    );
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
    return this.openValidated(ref, expectedParentSession).map(
      ({ record }) => record,
    );
  }

  /**
   * Reads host native entries for a live or historical child session.
   * Validates the ref, presence, header, and parent link, then returns
   * `getEntries()` output without copying transcript bytes into adapter
   * storage. Expected host throws become typed `SessionCorrupt`.
   */
  readSessionEntries(
    ref: string,
    expectedParentSession?: string,
  ): ResultAsync<PiNativeSessionEntries, PiNativeSessionError> {
    return this.openValidated(ref, expectedParentSession).andThen(
      ({ record, handle }) =>
        Result.fromThrowable(
          () => handle.getEntries(),
          (): PiNativeSessionError => ({
            type: "SessionCorrupt",
            ref: record.ref,
            reason: "unreadable",
          }),
        )().map((entries) => ({ record, entries })),
    );
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
          const leafId =
            typeof appended === "string" && appended.length > 0
              ? appended
              : (handle.getLeafId?.() ?? undefined);
          if (typeof leafId !== "string" || leafId.length === 0) {
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
            { readonly record: PiNativeSessionRecord; readonly leafId: string },
            PiNativeSessionError
          >({ record, leafId });
        });
      },
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
    return this.readSessionEntries(ref, expectedParentSession).andThen(
      ({ record, entries }) => {
        const metadata = readNativeThreadMetadata(entries);
        if (metadata === undefined) {
          return err<PiNativeThreadMetadata, PiNativeSessionError>({
            type: "SessionCorrupt",
            ref: record.ref,
            reason: "unreadable",
          });
        }
        return ok<PiNativeThreadMetadata, PiNativeSessionError>(metadata);
      },
    );
  }

  /**
   * Shared open path: prove the session file exists through the no-follow
   * port, open it through the host once, validate header/parent, and return
   * both the record and the live handle so callers can read entries without
   * a second open.
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
    const verified = verifyNativeSessionRef(ref);
    if (verified.isErr()) return errAsync(verified.error);
    const separator = verified.value.lastIndexOf("/");
    if (separator <= 0) {
      return errAsync({ type: "SessionRootViolation", reason: "path-escape" });
    }
    const component = verified.value.slice(0, separator);
    const fileName = verified.value.slice(separator + 1);
    const childDir = join(this.root, component);
    const path = join(childDir, fileName);
    return withDirectory(
      this.fs,
      childDir,
      false,
      verified.value,
      (directory) =>
        directory
          .readFile(fileName)
          .mapErr((error) => fromFsError(error, verified.value))
          .andThen((bytes) =>
            bytes === undefined
              ? errAsync<Uint8Array, PiNativeSessionError>({
                  type: "SessionMissing",
                  ref: verified.value,
                })
              : okAsync<Uint8Array, PiNativeSessionError>(bytes),
          ),
    ).andThen(() =>
      this.openHandle(
        path,
        childDir,
        component,
        verified.value,
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
      const header = Result.fromThrowable(
        () => handle.getHeader(),
        (): PiNativeSessionError => ({
          type: "SessionCorrupt",
          ref,
          reason: "unreadable",
        }),
      )();
      if (header.isErr()) return errAsync(header.error);
      const corruption = headerCorruption(header.value, expectedParentSession);
      if (corruption !== undefined || header.value === null) {
        return errAsync<
          {
            readonly record: PiNativeSessionRecord;
            readonly handle: PiNativeSessionHandle;
          },
          PiNativeSessionError
        >({
          type: "SessionCorrupt",
          ref,
          reason: corruption ?? "missing-header",
        });
      }
      return okAsync({
        record: {
          childId: component,
          sessionId: header.value.id,
          ref,
          path,
          parentSession: header.value.parentSession ?? "",
          cwd: header.value.cwd,
        },
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
   * {@link nativeSessionDeletionToken}; the deletion is then recorded by
   * appending - never rewriting - a 0600 tombstone line.
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
    const verified = verifyNativeSessionRef(record.ref);
    if (verified.isErr()) return errAsync(verified.error);
    const separator = verified.value.lastIndexOf("/");
    const component = verified.value.slice(0, separator);
    const fileName = verified.value.slice(separator + 1);
    const childDir = join(this.root, component);
    return withDirectory(
      this.fs,
      childDir,
      false,
      verified.value,
      (directory) =>
        directory
          .deleteFile(fileName)
          .mapErr((error) => fromFsError(error, verified.value)),
    ).andThen(() => this.appendTombstone(record));
  }

  /**
   * Appends one tombstone record. Uses the port's append primitive only, so
   * prior records can never be rewritten or truncated by this module.
   */
  appendTombstone(
    record: PiNativeSessionRecord,
  ): ResultAsync<PiNativeSessionTombstone, PiNativeSessionError> {
    const tombstone: PiNativeSessionTombstone = {
      version: 1,
      ref: record.ref,
      childId: record.childId,
      parentSession: record.parentSession,
      deletedAt: this.now().toISOString(),
      reason: "explicit-user-deletion",
    };
    const line = textEncoder.encode(`${JSON.stringify(tombstone)}\n`);
    return withDirectory(this.fs, this.root, true, record.ref, (directory) =>
      directory
        .appendFile(
          PI_NATIVE_SESSION_LAYOUT.tombstoneFile,
          line,
          PI_NATIVE_SESSION_LAYOUT.fileMode,
        )
        .mapErr((error): PiNativeSessionError => {
          if (error.type === "permissive-mode")
            return { type: "TombstoneAppendFailed", reason: "permission" };
          if (error.type === "unavailable")
            return { type: "TombstoneAppendFailed", reason: "unavailable" };
          return { type: "TombstoneAppendFailed", reason: "io" };
        })
        .map(() => tombstone),
    );
  }

  /** Reads every appended tombstone, newest last. Absent ledger reads empty. */
  readTombstones(): ResultAsync<
    readonly PiNativeSessionTombstone[],
    PiNativeSessionError
  > {
    return withDirectory(
      this.fs,
      this.root,
      false,
      PI_NATIVE_SESSION_LAYOUT.tombstoneFile,
      (directory) =>
        directory
          .readFile(PI_NATIVE_SESSION_LAYOUT.tombstoneFile)
          .mapErr((error) =>
            fromFsError(error, PI_NATIVE_SESSION_LAYOUT.tombstoneFile),
          )
          .map((bytes) => parseTombstones(bytes)),
    ).orElse((error) =>
      error.type === "SessionMissing"
        ? okAsync<readonly PiNativeSessionTombstone[], PiNativeSessionError>([])
        : errAsync(error),
    );
  }
}

function parseTombstones(
  bytes: Uint8Array | undefined,
): readonly PiNativeSessionTombstone[] {
  if (bytes === undefined) return [];
  const text = new TextDecoder().decode(bytes);
  const records: PiNativeSessionTombstone[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = Result.fromThrowable(
      () => JSON.parse(line) as unknown,
      () => undefined,
    )();
    if (parsed.isErr()) continue;
    const value = parsed.value;
    if (typeof value !== "object" || value === null) continue;
    const candidate = value as Partial<PiNativeSessionTombstone>;
    if (
      candidate.version !== 1 ||
      typeof candidate.ref !== "string" ||
      typeof candidate.childId !== "string" ||
      typeof candidate.deletedAt !== "string"
    ) {
      continue;
    }
    records.push({
      version: 1,
      ref: candidate.ref,
      childId: candidate.childId,
      parentSession: candidate.parentSession ?? "",
      deletedAt: candidate.deletedAt,
      reason: "explicit-user-deletion",
    });
  }
  return records;
}
