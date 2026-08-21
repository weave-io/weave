/**
 * No-follow directory/file guard for the Runtime Store (Pi adapter contract).
 *
 * The engine Runtime Store under `.weave/runtime/**` may open only after
 * project trust. This guard acquires and *holds*, for the store's entire
 * lifetime, no-follow handles for both the canonical project root and the
 * runtime directory. It walks every path component between them with a
 * segment-by-segment `openat(..., O_NOFOLLOW)` (creating missing segments
 * with `mkdirat`, never a shelled-out `mkdir` process) so an attacker cannot
 * defeat containment by replacing an *intermediate* ancestor (e.g. `.weave`)
 * with a symlink — a single absolute-path `open(..., O_NOFOLLOW)` call only
 * proves the final path component isn't a symlink, not any ancestor, which
 * is why that shortcut is rejected here.
 *
 * ## The bun:sqlite handoff and why there is no path reopen at all
 *
 * Pi adapter contract forbids "a path check followed by an unrelated reopen".
 * `bun:sqlite`'s `Database` constructor only ever accepts a path *string*
 * or in-memory bytes (verified against `bun-types`/the compiled `bun:sqlite`
 * module — there is no fd-based or `O_NOFOLLOW`-aware constructor). Handing
 * it a path string after proving that path's identity through a completely
 * separate, held directory descriptor is exactly the forbidden pattern, and
 * two independent empirical checks (via `Bun.file()` and a raw libc
 * `open()` call) confirmed that neither `/proc/self/fd/<dirfd>/<name>`
 * (Linux-style magic-symlink aliasing) nor `/dev/fd/<filefd>` (Darwin) let
 * `bun:sqlite` resolve a path *relative to an already-held descriptor* —
 * `bun:sqlite` always fails to open through either alias.
 *
 * This guard therefore never hands `bun:sqlite` a path string for the
 * runtime DB at all. Instead:
 *
 *  - `readLeafBytes` reads the *entire* current contents of `weave.db`
 *    through one no-follow `openat` relative to the held runtime-directory
 *    descriptor. The caller (`SqliteRuntimeStore`) deserializes those bytes
 *    into an **in-memory** `bun:sqlite` `Database` (`new Database(bytes)`)
 *    — `bun:sqlite` never touches a path for the live database at all, so
 *    there is nothing to "reopen".
 *  - `writeLeafAtomic` persists a new snapshot (`Database#serialize()`)
 *    back to `weave.db` by writing to a fresh temp file *through the same
 *    held descriptor* (`openat` + `write` + `fsync`), then atomically
 *    replacing the leaf via `renameat` on that same descriptor, then
 *    `fsync`s the directory itself. The identity returned afterward is the
 *    new bound identity for subsequent revalidation.
 *
 * Because the live database is in-memory, `bun:sqlite`'s WAL mode and its
 * `-wal`/`-shm` sidecar files never come into existence — durability comes
 * entirely from `writeLeafAtomic`'s temp-file-then-rename sequence, which is
 * the standard POSIX atomic-replace pattern, performed exclusively through
 * the already no-follow-proven directory descriptor.
 *
 * @see docs/adapters/pi.md
 */

import { basename } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { z } from "zod";

import {
  cstr,
  ERRNO_EEXIST,
  ERRNO_ENOENT,
  type FdIdentity,
  identityFromFd,
  LOCK_EX,
  LOCK_NB,
  LOCK_UN,
  type LoadedLibc,
  libcPath,
  loadLibc,
  type NoFollowFfiError,
  type PlatformFlags,
  platformFlags,
  sanitizeCause,
  withRestrictiveCreateMask,
} from "../nofollow-ffi.js";

/**
 * Bounded, non-blocking `flock` acquisition (Pi adapter contract concurrency
 * hardening). Every attempt uses `LOCK_NB` so a contended lock returns
 * immediately instead of blocking the single-threaded event loop — a
 * blocking `flock` FFI call would freeze the whole process, including the
 * continuation that would otherwise release a lock held by *this same*
 * process, which is a guaranteed deadlock. Attempt 0 yields one microtask;
 * later attempts back off with a capped exponential `Bun.sleep`, mirroring
 * `SqlitePermissionApprovalRepository`'s `withSqliteBusyRetry`.
 */
const LOCK_ACQUIRE_RETRIES = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RuntimeDirectoryGuardError =
  | { readonly type: "unavailable"; readonly message: string }
  | {
      readonly type: "symlink-rejected";
      readonly message: string;
      readonly cause?: string;
    }
  | {
      readonly type: "identity-changed";
      readonly message: string;
      readonly cause?: string;
    }
  | { readonly type: "io"; readonly message: string; readonly cause?: string }
  | {
      readonly type: "locked";
      readonly message: string;
      readonly cause?: string;
    };

/** Stable identity (dev/ino) of a held directory or file descriptor. */
export type RuntimeFileIdentity = FdIdentity;

export interface VerifyLeafOptions {
  readonly create: boolean;
  readonly mode: number;
}

export interface RuntimeDirectoryHandle {
  /** Absolute path of the held runtime directory. Diagnostics only — never re-derived for an open. */
  readonly path: string;

  /**
   * Re-verifies the held project-root and runtime-directory descriptors
   * still refer to the identity captured when they were opened. Used to
   * revalidate stable parent/target identity across migration and every
   * subsequent transaction commit (Pi adapter contract).
   */
  identity(): ResultAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError>;

  /**
   * Opens (creating if `create` is true and it is missing) `fileName`
   * relative to the held runtime directory descriptor via a no-follow
   * `openat`, applies `mode`, and returns its identity. Never re-derives a
   * path string for this operation.
   */
  verifyLeaf(
    fileName: string,
    options: VerifyLeafOptions,
  ): ResultAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError>;

  /**
   * Reads the full contents of `fileName` through one no-follow `openat`
   * relative to the held runtime directory descriptor. Returns an empty
   * `Uint8Array` if the file does not exist yet (a brand-new store).
   */
  readLeafBytes(
    fileName: string,
  ): ResultAsync<Uint8Array, RuntimeDirectoryGuardError>;

  /**
   * Atomically replaces `fileName`'s contents with `bytes`: writes to a
   * fresh temp file created via `openat` relative to the held descriptor,
   * `fsync`s it, `renameat`s it over `fileName` (still relative to the same
   * held descriptor — never a path string), then `fsync`s the directory.
   * Returns the newly-bound identity.
   */
  writeLeafAtomic(
    fileName: string,
    bytes: Uint8Array,
    mode: number,
  ): ResultAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError>;

  /**
   * Acquires a process/host-wide exclusive advisory lock (`flock`) scoped
   * to `fileName`, opening (and thereafter holding, like the runtime
   * directory fd itself) a dedicated no-follow lock leaf on first use.
   * Every other `RuntimeDirectoryHandle` — in this process or another —
   * that opens the same directory and the same `fileName` contends on the
   * same OS-level lock. Bounded, non-blocking retries with backoff; never
   * blocks the event loop. Must be paired with `unlockLeaf`.
   */
  lockLeaf(fileName: string): ResultAsync<void, RuntimeDirectoryGuardError>;

  /** Releases a previously acquired exclusive lock for `fileName`. Idempotent (unlocking an already-unlocked leaf is not an error). */
  unlockLeaf(fileName: string): ResultAsync<void, RuntimeDirectoryGuardError>;

  /** Closes every held descriptor, including any lock leaves opened by `lockLeaf` (which also releases their locks). Idempotent. */
  close(): void;
}

const runtimeDirectoryGuardErrorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unavailable"), message: z.string() }),
  z.object({
    type: z.literal("symlink-rejected"),
    message: z.string(),
    cause: z.string().optional(),
  }),
  z.object({
    type: z.literal("identity-changed"),
    message: z.string(),
    cause: z.string().optional(),
  }),
  z.object({
    type: z.literal("io"),
    message: z.string(),
    cause: z.string().optional(),
  }),
  z.object({
    type: z.literal("locked"),
    message: z.string(),
    cause: z.string().optional(),
  }),
]);

export interface RuntimeDirectoryGuard {
  /**
   * Establishes a held, no-follow chain from `projectRoot` (assumed to
   * already exist — it is the harness-established trust boundary) down
   * through `segments` (each created via `mkdirat` if missing, each proven
   * via no-follow `openat`), applying `mode` to every segment this guard
   * creates or owns.
   */
  ensureRuntimeDirectory(
    projectRoot: string,
    segments: readonly string[],
    mode: number,
  ): ResultAsync<RuntimeDirectoryHandle, RuntimeDirectoryGuardError>;
}

/** Convenience: the leaf file name for a `weave.db`-style absolute path. */
export function runtimeLeafName(dbPath: string): string {
  return basename(dbPath);
}

/** Compares two identities by `dev`+`ino` only (size/mtime are observational). */
export function directoryIdentitiesMatch(
  a: RuntimeFileIdentity,
  b: RuntimeFileIdentity,
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Maps a low-level `NoFollowFfiError` onto the guard's closed error type. */
function mapFfiError(
  cause: NoFollowFfiError,
  type: RuntimeDirectoryGuardError["type"] = "io",
): RuntimeDirectoryGuardError {
  switch (type) {
    case "unavailable":
      return { type, message: cause.message };
    case "symlink-rejected":
      return { type, message: cause.message, cause: cause.cause };
    case "identity-changed":
      return { type, message: cause.message, cause: cause.cause };
    case "locked":
      return { type, message: cause.message, cause: cause.cause };
    case "io":
      return { type, message: cause.message, cause: cause.cause };
  }
}

// ---------------------------------------------------------------------------
// Production implementation
// ---------------------------------------------------------------------------

class BunRuntimeDirectoryHandle implements RuntimeDirectoryHandle {
  private closed = false;
  /** Lazily-opened, held-for-lifetime lock leaf fds, keyed by the protected `fileName`. Instance-owned — never a module-global coordinator. */
  private readonly lockFds = new Map<string, number>();

  constructor(
    readonly path: string,
    private rootFd: number,
    private runtimeDirFd: number,
    private readonly loaded: LoadedLibc,
    private readonly flags: PlatformFlags,
    private boundRootIdentity: RuntimeFileIdentity,
    private boundRuntimeIdentity: RuntimeFileIdentity,
  ) {}

  identity(): ResultAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError> {
    if (this.closed) {
      return errAsync({
        type: "unavailable",
        message: "runtime directory handle is closed",
      });
    }
    return identityFromFd(this.rootFd, "directory")
      .mapErr((cause) => mapFfiError(cause, "io"))
      .andThen((rootIdentity) => {
        if (!directoryIdentitiesMatch(this.boundRootIdentity, rootIdentity)) {
          return errAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError>({
            type: "identity-changed",
            message: "project root identity changed since it was opened",
          });
        }
        return identityFromFd(this.runtimeDirFd, "directory").mapErr((cause) =>
          mapFfiError(cause, "io"),
        );
      })
      .andThen((runtimeIdentity) => {
        if (
          !directoryIdentitiesMatch(this.boundRuntimeIdentity, runtimeIdentity)
        ) {
          return errAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError>({
            type: "identity-changed",
            message: "runtime directory identity changed since it was opened",
          });
        }
        return okAsync(runtimeIdentity);
      });
  }

  verifyLeaf(
    fileName: string,
    options: VerifyLeafOptions,
  ): ResultAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError> {
    if (this.closed) {
      return errAsync({
        type: "unavailable",
        message: "runtime directory handle is closed",
      });
    }
    const { symbols } = this.loaded;
    const openFlags = options.create
      ? this.flags.O_RDWR |
        this.flags.O_CREAT |
        this.flags.O_NOFOLLOW |
        this.flags.O_CLOEXEC
      : this.flags.O_RDONLY | this.flags.O_NOFOLLOW | this.flags.O_CLOEXEC;

    const fd = options.create
      ? withRestrictiveCreateMask(symbols, () =>
          symbols.openat(
            this.runtimeDirFd,
            cstr(fileName),
            openFlags,
            options.mode,
          ),
        )
      : symbols.openat(
          this.runtimeDirFd,
          cstr(fileName),
          openFlags,
          options.mode,
        );
    if (fd < 0) {
      const missing = this.loaded.readErrno() === ERRNO_ENOENT;
      if (missing && !options.create) {
        return errAsync({
          type: "io",
          message: `'${fileName}' does not exist`,
        });
      }
      return errAsync({
        type: "symlink-rejected",
        message: `refusing to open '${fileName}' through a symlinked or otherwise unsafe path (no-follow rejected)`,
      });
    }
    symbols.fchmod(fd, options.mode);
    return identityFromFd(fd, "file")
      .mapErr((cause) => mapFfiError(cause, "io"))
      .map((identityResult) => {
        symbols.close(fd);
        return identityResult;
      })
      .mapErr((mappedError) => {
        symbols.close(fd);
        return mappedError;
      });
  }

  readLeafBytes(
    fileName: string,
  ): ResultAsync<Uint8Array, RuntimeDirectoryGuardError> {
    if (this.closed) {
      return errAsync({
        type: "unavailable",
        message: "runtime directory handle is closed",
      });
    }
    const { symbols } = this.loaded;
    const fd = symbols.openat(
      this.runtimeDirFd,
      cstr(fileName),
      this.flags.O_RDONLY | this.flags.O_NOFOLLOW | this.flags.O_CLOEXEC,
      0,
    );
    if (fd < 0) {
      const missing = this.loaded.readErrno() === ERRNO_ENOENT;
      if (missing) return okAsync(new Uint8Array(0));
      return errAsync({
        type: "symlink-rejected",
        message: `refusing to read '${fileName}' through a symlinked or otherwise unsafe path (no-follow rejected)`,
      });
    }
    return ResultAsync.fromPromise(
      Bun.file(fd).arrayBuffer(),
      (cause) =>
        ({
          type: "io",
          message: "failed to read runtime DB bytes",
          cause: sanitizeCause(cause),
        }) satisfies RuntimeDirectoryGuardError,
    )
      .map((buffer) => {
        symbols.close(fd);
        return new Uint8Array(buffer);
      })
      .mapErr((mappedError) => {
        symbols.close(fd);
        return mappedError;
      });
  }

  writeLeafAtomic(
    fileName: string,
    bytes: Uint8Array,
    mode: number,
  ): ResultAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError> {
    if (this.closed) {
      return errAsync({
        type: "unavailable",
        message: "runtime directory handle is closed",
      });
    }
    const { symbols } = this.loaded;
    const tempName = `.${fileName}.tmp-${crypto.randomUUID()}`;
    const openFlags =
      this.flags.O_RDWR |
      this.flags.O_CREAT |
      this.flags.O_EXCL |
      this.flags.O_TRUNC |
      this.flags.O_NOFOLLOW |
      this.flags.O_CLOEXEC;
    const tempFd = withRestrictiveCreateMask(symbols, () =>
      symbols.openat(this.runtimeDirFd, cstr(tempName), openFlags, mode),
    );
    if (tempFd < 0) {
      return errAsync({
        type: "io",
        message: `failed to create a temporary file for the atomic write of '${fileName}'`,
      });
    }
    // The temp file was created inside `withRestrictiveCreateMask`, so its
    // on-disk mode right now is whatever the process umask left after
    // masking the unreliable vararg `mode` — i.e. no permission bits at all.
    // `renameat` below preserves whatever mode the temp file has at close
    // time, so the real, intended `mode` MUST be restored here via the
    // fixed-arity (therefore reliable) `fchmod` before anything relies on
    // the file being readable/writable.
    symbols.fchmod(tempFd, mode);

    return ResultAsync.fromPromise(
      (async () => {
        let tempClosed = false;
        try {
          let written = 0;
          while (written < bytes.length) {
            const slice = bytes.subarray(written);
            const rc = symbols.write(tempFd, slice, slice.length);
            if (rc < 0) {
              throw new Error(
                `write failed (errno ${this.loaded.readErrno()})`,
              );
            }
            if (rc === 0) {
              throw new Error("write returned 0 bytes unexpectedly");
            }
            written += rc;
          }
          symbols.fsync(tempFd);
          symbols.close(tempFd);
          tempClosed = true;
          const renameRc = symbols.renameat(
            this.runtimeDirFd,
            cstr(tempName),
            this.runtimeDirFd,
            cstr(fileName),
          );
          if (renameRc !== 0) {
            throw new Error(
              `renameat failed (errno ${this.loaded.readErrno()})`,
            );
          }
          symbols.fsync(this.runtimeDirFd);
        } finally {
          if (!tempClosed) {
            symbols.close(tempFd);
            symbols.unlinkat(this.runtimeDirFd, cstr(tempName), 0);
          }
        }
      })(),
      (cause) =>
        ({
          type: "io",
          message: `failed to atomically persist '${fileName}'`,
          cause: sanitizeCause(cause),
        }) satisfies RuntimeDirectoryGuardError,
    ).andThen(() => this.verifyLeaf(fileName, { create: false, mode }));
  }

  /** Opens (creating if missing) the dedicated lock leaf for `fileName` through the held runtime directory descriptor, caching the fd for reuse. Never re-derives a path string for subsequent calls. */
  private openLockFd(
    fileName: string,
  ): ResultAsync<number, RuntimeDirectoryGuardError> {
    const cached = this.lockFds.get(fileName);
    if (cached !== undefined) return okAsync(cached);
    const { symbols } = this.loaded;
    const lockName = `.${fileName}.lock`;
    const openFlags =
      this.flags.O_RDWR |
      this.flags.O_CREAT |
      this.flags.O_NOFOLLOW |
      this.flags.O_CLOEXEC;
    const fd = withRestrictiveCreateMask(symbols, () =>
      symbols.openat(this.runtimeDirFd, cstr(lockName), openFlags, 0o600),
    );
    if (fd < 0) {
      return errAsync({
        type: "io",
        message: `failed to open the lock leaf for '${fileName}'`,
      });
    }
    symbols.fchmod(fd, 0o600);
    this.lockFds.set(fileName, fd);
    return okAsync(fd);
  }

  lockLeaf(fileName: string): ResultAsync<void, RuntimeDirectoryGuardError> {
    if (this.closed) {
      return errAsync({
        type: "unavailable",
        message: "runtime directory handle is closed",
      });
    }
    return this.openLockFd(fileName).andThen((fd) =>
      ResultAsync.fromPromise(
        (async () => {
          const { symbols } = this.loaded;
          for (let attempt = 0; attempt <= LOCK_ACQUIRE_RETRIES; attempt += 1) {
            const rc = symbols.flock(fd, LOCK_EX | LOCK_NB);
            if (rc === 0) return;
            if (attempt === 0) {
              await Promise.resolve();
            } else {
              await Bun.sleep(Math.min(2 ** (attempt - 1), 16));
            }
          }
          throw new Error(
            `failed to acquire the exclusive lock for '${fileName}' after ${LOCK_ACQUIRE_RETRIES + 1} attempts`,
          );
        })(),
        (cause) =>
          ({
            type: "locked",
            message: `failed to acquire the exclusive lock for '${fileName}'`,
            cause: sanitizeCause(cause),
          }) satisfies RuntimeDirectoryGuardError,
      ),
    );
  }

  unlockLeaf(fileName: string): ResultAsync<void, RuntimeDirectoryGuardError> {
    if (this.closed) {
      return errAsync({
        type: "unavailable",
        message: "runtime directory handle is closed",
      });
    }
    const fd = this.lockFds.get(fileName);
    // Nothing was ever locked for this leaf: releasing is a no-op, not an
    // error, mirroring `flock`'s own idempotent-unlock semantics.
    if (fd === undefined) return okAsync(undefined);
    this.loaded.symbols.flock(fd, LOCK_UN);
    return okAsync(undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fd of this.lockFds.values()) {
      // Releases the flock as a side effect of closing the last fd
      // referencing this open file description, in addition to the
      // explicit `LOCK_UN` in `unlockLeaf` — belt and suspenders against
      // any early-return path that closed the handle without unlocking.
      this.loaded.symbols.flock(fd, LOCK_UN);
      this.loaded.symbols.close(fd);
    }
    this.lockFds.clear();
    this.loaded.symbols.close(this.runtimeDirFd);
    if (this.rootFd !== this.runtimeDirFd) {
      this.loaded.symbols.close(this.rootFd);
    }
    this.loaded.library.close();
  }
}

/** Distinguishes "component missing, safe to create" from every other no-follow rejection. */
function isMissingErrno(loaded: LoadedLibc): boolean {
  return loaded.readErrno() === ERRNO_ENOENT;
}

export class BunRuntimeDirectoryGuard implements RuntimeDirectoryGuard {
  ensureRuntimeDirectory(
    projectRoot: string,
    segments: readonly string[],
    mode: number,
  ): ResultAsync<RuntimeDirectoryHandle, RuntimeDirectoryGuardError> {
    if (platformFlags() === undefined || libcPath() === undefined) {
      return errAsync({
        type: "unavailable",
        message: "no-follow filesystem I/O is unavailable on this platform",
      });
    }
    // Zero segments means `projectRoot` itself *is* the runtime directory
    // (the caller did not provide a more distant, ancestor-proving root);
    // `openChain` opens `projectRoot` once and reuses that same fd as the
    // runtime directory fd - still a full no-follow, held-descriptor proof,
    // just with no intermediate ancestor components to walk.
    const loadedResult = loadLibc();
    if (loadedResult.isErr()) {
      return errAsync(mapFfiError(loadedResult.error, "unavailable"));
    }
    const loaded = loadedResult.value;
    const flags = platformFlags();
    if (flags === undefined) {
      loaded.library.close();
      return errAsync({
        type: "unavailable",
        message: "no-follow filesystem I/O is unavailable on this platform",
      });
    }

    return this.openChain(projectRoot, segments, mode, loaded, flags).mapErr(
      (openChainError) => {
        loaded.library.close();
        return openChainError;
      },
    );
  }

  private openChain(
    projectRoot: string,
    segments: readonly string[],
    mode: number,
    loaded: LoadedLibc,
    flags: PlatformFlags,
  ): ResultAsync<RuntimeDirectoryHandle, RuntimeDirectoryGuardError> {
    const { symbols } = loaded;
    const rootFd = symbols.open(
      cstr(projectRoot),
      flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW | flags.O_CLOEXEC,
      0,
    );
    if (rootFd < 0) {
      return errAsync({
        type: "io",
        message: `project root '${projectRoot}' could not be opened as a directory`,
      });
    }

    return identityFromFd(rootFd, "directory")
      .mapErr((cause) => {
        symbols.close(rootFd);
        return mapFfiError(cause, "io");
      })
      .andThen((rootIdentity) =>
        this.walkSegments(rootFd, segments, mode, loaded, flags).map(
          (runtimeDirFd) => ({
            rootIdentity,
            runtimeDirFd,
          }),
        ),
      )
      .andThen(({ rootIdentity, runtimeDirFd }) =>
        identityFromFd(runtimeDirFd, "directory")
          .mapErr((cause) => {
            symbols.close(runtimeDirFd);
            if (rootFd !== runtimeDirFd) symbols.close(rootFd);
            return mapFfiError(cause, "io");
          })
          .map((runtimeIdentity) => {
            const fullPath = [projectRoot, ...segments].join("/");
            return new BunRuntimeDirectoryHandle(
              fullPath,
              rootFd,
              runtimeDirFd,
              loaded,
              flags,
              rootIdentity,
              runtimeIdentity,
            );
          }),
      );
  }

  /** Opens (creating missing components via `mkdirat`) every segment in order, holding only the current and final descriptors — every intermediate hop is closed once the next is open. Returns the final segment's held fd. */
  private walkSegments(
    rootFd: number,
    segments: readonly string[],
    mode: number,
    loaded: LoadedLibc,
    flags: PlatformFlags,
  ): ResultAsync<number, RuntimeDirectoryGuardError> {
    const { symbols } = loaded;
    const openDirFlags =
      flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW | flags.O_CLOEXEC;

    return ResultAsync.fromPromise(
      (async () => {
        let currentFd = rootFd;
        for (const segment of segments) {
          let childFd = symbols.openat(
            currentFd,
            cstr(segment),
            openDirFlags,
            0,
          );
          if (childFd < 0) {
            const missing = isMissingErrno(loaded);
            if (!missing) {
              if (currentFd !== rootFd) symbols.close(currentFd);
              throw {
                type: "symlink-rejected",
                message: `refusing to traverse '${segment}': component is a symlink or otherwise not a plain directory (no-follow rejected)`,
              } satisfies RuntimeDirectoryGuardError;
            }
            const mkdirRc = symbols.mkdirat(currentFd, cstr(segment), mode);
            if (mkdirRc !== 0 && loaded.readErrno() !== ERRNO_EEXIST) {
              if (currentFd !== rootFd) symbols.close(currentFd);
              throw {
                type: "io",
                message: `failed to create runtime directory component '${segment}'`,
              } satisfies RuntimeDirectoryGuardError;
            }
            childFd = symbols.openat(currentFd, cstr(segment), openDirFlags, 0);
            if (childFd < 0) {
              if (currentFd !== rootFd) symbols.close(currentFd);
              throw {
                type: "symlink-rejected",
                message: `refusing to traverse '${segment}': component is a symlink or otherwise not a plain directory (no-follow rejected)`,
              } satisfies RuntimeDirectoryGuardError;
            }
          }
          symbols.fchmod(childFd, mode);
          if (currentFd !== rootFd) symbols.close(currentFd);
          currentFd = childFd;
        }
        return currentFd;
      })(),
      (cause) => {
        const parsed = runtimeDirectoryGuardErrorSchema.safeParse(cause);
        if (parsed.success) return parsed.data;
        return {
          type: "io",
          message: "failed to walk the runtime directory chain",
          cause: sanitizeCause(cause),
        } satisfies RuntimeDirectoryGuardError;
      },
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory test double (Pi adapter contract — no real filesystem)
// ---------------------------------------------------------------------------

interface MemoryLeaf {
  identity: RuntimeFileIdentity;
  isSymlink: boolean;
  bytes: Uint8Array;
}

let memoryInoCounter = 1000;
function nextIno(): number {
  memoryInoCounter += 1;
  return memoryInoCounter;
}

/**
 * Minimal FIFO async mutex used only by `MemoryRuntimeDirectoryGuard` to
 * give the in-memory test double the same mutual-exclusion contract the
 * real `flock`-backed handle provides, when a test shares one guard across
 * multiple simulated store instances. Instance-owned (one per protected
 * leaf name, held in a guard-instance `Map`) — never a module-global.
 */
class AsyncLeafMutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.locked = true;
        resolve();
      });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }
}

export class MemoryRuntimeDirectoryGuard implements RuntimeDirectoryGuard {
  private directorySymlink = false;
  private readonly leafLocks = new Map<string, AsyncLeafMutex>();
  private runtimeIdentity: RuntimeFileIdentity = {
    dev: 1,
    ino: nextIno(),
    size: 0,
    mtimeMs: 0,
  };
  private readonly leaves = new Map<string, MemoryLeaf>();

  /** Simulates the runtime directory (or an ancestor) being a symlink: every open through it fails closed. */
  simulateDirectorySymlink(): void {
    this.directorySymlink = true;
  }

  /** Simulates the runtime directory's own identity changing after it was opened. */
  swapDirectoryIdentity(): void {
    this.runtimeIdentity = { dev: 1, ino: nextIno(), size: 0, mtimeMs: 0 };
  }

  /** Simulates `fileName` being a symlink instead of a plain file. */
  simulateLeafSymlink(fileName: string): void {
    this.leaves.set(fileName, {
      identity: { dev: 1, ino: nextIno(), size: 0, mtimeMs: 0 },
      isSymlink: true,
      bytes: new Uint8Array(0),
    });
  }

  /** Simulates `fileName`'s identity changing out from under an already-verified leaf. */
  swapLeafIdentity(fileName: string): void {
    const existing = this.leaves.get(fileName);
    this.leaves.set(fileName, {
      identity: { dev: 1, ino: nextIno(), size: 0, mtimeMs: 0 },
      isSymlink: existing?.isSymlink ?? false,
      bytes: existing?.bytes ?? new Uint8Array(0),
    });
  }

  ensureRuntimeDirectory(
    projectRoot: string,
    segments: readonly string[],
    _mode: number,
  ): ResultAsync<RuntimeDirectoryHandle, RuntimeDirectoryGuardError> {
    if (this.directorySymlink) {
      return errAsync({
        type: "symlink-rejected",
        message:
          "refusing to traverse a simulated symlinked runtime directory component (no-follow rejected)",
      });
    }
    const fullPath = [projectRoot, ...segments].join("/");
    let closed = false;

    const handle: RuntimeDirectoryHandle = {
      path: fullPath,
      identity: (): ResultAsync<
        RuntimeFileIdentity,
        RuntimeDirectoryGuardError
      > => {
        if (closed) {
          return errAsync({ type: "unavailable", message: "handle is closed" });
        }
        return okAsync(this.runtimeIdentity);
      },
      verifyLeaf: (
        fileName: string,
        options: VerifyLeafOptions,
      ): ResultAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError> => {
        if (closed) {
          return errAsync({ type: "unavailable", message: "handle is closed" });
        }
        const existing = this.leaves.get(fileName);
        if (existing?.isSymlink) {
          return errAsync({
            type: "symlink-rejected",
            message: `refusing to open '${fileName}' through a simulated symlink (no-follow rejected)`,
          });
        }
        if (existing) return okAsync(existing.identity);
        if (!options.create) {
          return errAsync({
            type: "io",
            message: `'${fileName}' does not exist and create was not requested`,
          });
        }
        const created: MemoryLeaf = {
          identity: { dev: 1, ino: nextIno(), size: 0, mtimeMs: 0 },
          isSymlink: false,
          bytes: new Uint8Array(0),
        };
        this.leaves.set(fileName, created);
        return okAsync(created.identity);
      },
      readLeafBytes: (
        fileName: string,
      ): ResultAsync<Uint8Array, RuntimeDirectoryGuardError> => {
        if (closed) {
          return errAsync({ type: "unavailable", message: "handle is closed" });
        }
        const existing = this.leaves.get(fileName);
        if (existing?.isSymlink) {
          return errAsync({
            type: "symlink-rejected",
            message: `refusing to read '${fileName}' through a simulated symlink (no-follow rejected)`,
          });
        }
        return okAsync(existing?.bytes ?? new Uint8Array(0));
      },
      writeLeafAtomic: (
        fileName: string,
        bytes: Uint8Array,
        _mode: number,
      ): ResultAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError> => {
        if (closed) {
          return errAsync({ type: "unavailable", message: "handle is closed" });
        }
        const existing = this.leaves.get(fileName);
        if (existing?.isSymlink) {
          return errAsync({
            type: "symlink-rejected",
            message: `refusing to replace '${fileName}' through a simulated symlink (no-follow rejected)`,
          });
        }
        const updated: MemoryLeaf = {
          identity: {
            dev: 1,
            ino: nextIno(),
            size: bytes.length,
            mtimeMs: Date.now(),
          },
          isSymlink: false,
          bytes,
        };
        this.leaves.set(fileName, updated);
        return okAsync(updated.identity);
      },
      lockLeaf: (
        fileName: string,
      ): ResultAsync<void, RuntimeDirectoryGuardError> => {
        if (closed) {
          return errAsync({ type: "unavailable", message: "handle is closed" });
        }
        let mutex = this.leafLocks.get(fileName);
        if (mutex === undefined) {
          mutex = new AsyncLeafMutex();
          this.leafLocks.set(fileName, mutex);
        }
        return ResultAsync.fromSafePromise(mutex.acquire());
      },
      unlockLeaf: (
        fileName: string,
      ): ResultAsync<void, RuntimeDirectoryGuardError> => {
        if (closed) {
          return errAsync({ type: "unavailable", message: "handle is closed" });
        }
        this.leafLocks.get(fileName)?.release();
        return okAsync(undefined);
      },
      close: (): void => {
        closed = true;
      },
    };
    return okAsync(handle);
  }
}
