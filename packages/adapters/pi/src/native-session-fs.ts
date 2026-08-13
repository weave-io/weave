/**
 * The production no-follow filesystem port for Weave-owned native Pi child
 * sessions.
 *
 * Native session storage is defined against the structural
 * {@link PiNativeSessionFsPort} so tests can supply an in-memory fake. This
 * module owns the one production implementation: real `openat(O_NOFOLLOW)`
 * directory handles with 0700 directories and 0600 files, plus the in-memory
 * fake used by tests.
 */

import { dlopen, ptr, read } from "bun:ffi";
import { platform } from "node:os";
import { isAbsolute } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  PI_NATIVE_SESSION_MAX_RANGE_LENGTH,
  type PiNativeSessionDirectory,
  type PiNativeSessionFileHandle,
  type PiNativeSessionFileRange,
  type PiNativeSessionFileStat,
  type PiNativeSessionFsError,
  type PiNativeSessionFsPort,
} from "./child-native-sessions.js";

/** Device/inode/mode triple used to bind a handle to one filesystem node. */
interface NodeIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

/** Regular-file identity including size for bounded range reads. */
interface FileNodeIdentity extends NodeIdentity {
  readonly size: number;
  /** Last-modification milliseconds, used to detect same-size rewrites. */
  readonly mtimeMs: number;
}

const textEncoder = new TextEncoder();

function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

function sameIdentity(left: NodeIdentity, right: NodeIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileStat(
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

function toFileStat(identity: FileNodeIdentity): PiNativeSessionFileStat {
  return {
    dev: identity.dev,
    ino: identity.ino,
    size: identity.size,
    mtimeMs: identity.mtimeMs,
  };
}

function validateRange(
  offset: number,
  length: number,
): Result<void, PiNativeSessionFsError> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    length > PI_NATIVE_SESSION_MAX_RANGE_LENGTH
  ) {
    return err({ type: "invalid-range" });
  }
  return ok(undefined);
}

function isFsError(value: unknown): value is PiNativeSessionFsError {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === "relative-xdg-data-home" ||
    type === "empty-home" ||
    type === "unsafe-path" ||
    type === "unavailable" ||
    type === "missing" ||
    type === "symlink-rejected" ||
    type === "identity-changed" ||
    type === "invalid-range" ||
    type === "permissive-mode" ||
    type === "wrong-kind" ||
    type === "already-exists" ||
    type === "io"
  );
}

function mapThrownError(value: unknown): PiNativeSessionFsError {
  return isFsError(value) ? value : { type: "io" };
}

function fsErrAsync<T = never>(
  error: PiNativeSessionFsError,
): ResultAsync<T, PiNativeSessionFsError> {
  return errAsync<T, PiNativeSessionFsError>(error);
}

function fsVoidAsync(): ResultAsync<void, PiNativeSessionFsError> {
  return okAsync<void, PiNativeSessionFsError>(undefined);
}

async function unwrapResult<T, E>(result: ResultAsync<T, E>): Promise<T> {
  const settled = await result;
  if (settled.isErr()) throw settled.error;
  return settled.value;
}

interface NativeFlags {
  readonly O_RDONLY: number;
  readonly O_RDWR: number;
  readonly O_CREAT: number;
  readonly O_EXCL: number;
  readonly O_TRUNC: number;
  readonly O_APPEND: number;
  readonly O_DIRECTORY: number;
  readonly O_NOFOLLOW: number;
  readonly O_CLOEXEC: number;
  readonly AT_FDCWD: number;
}

interface NativeLibc {
  readonly flags: NativeFlags;
  readonly open: (path: Uint8Array, flags: number, mode: number) => number;
  readonly openat: (
    dir: number,
    path: Uint8Array,
    flags: number,
    mode: number,
  ) => number;
  readonly mkdirat: (dir: number, path: Uint8Array, mode: number) => number;
  readonly close: (fd: number) => number;
  readonly fchmod: (fd: number, mode: number) => number;
  readonly write: (fd: number, bytes: Uint8Array, count: number) => number;
  readonly pread: (
    fd: number,
    bytes: Uint8Array,
    count: number,
    offset: number,
  ) => number;
  readonly fsync: (fd: number) => number;
  readonly renameat: (
    oldDir: number,
    oldName: Uint8Array,
    newDir: number,
    newName: Uint8Array,
  ) => number;
  readonly unlinkat: (dir: number, name: Uint8Array, flags: number) => number;
  readonly errno: () => number;
  readonly dispose: () => void;
}

const ERRNO_ENOENT = 2;
const ERRNO_EEXIST = 17;

function nativeFlags(): NativeFlags | undefined {
  if (platform() === "darwin") {
    return {
      O_RDONLY: 0,
      O_RDWR: 2,
      O_CREAT: 0x200,
      O_EXCL: 0x800,
      O_TRUNC: 0x400,
      O_APPEND: 8,
      O_DIRECTORY: 0x100000,
      O_NOFOLLOW: 0x100,
      O_CLOEXEC: 0x1000000,
      AT_FDCWD: -2,
    };
  }
  if (platform() === "linux") {
    return {
      O_RDONLY: 0,
      O_RDWR: 2,
      O_CREAT: 0x40,
      O_EXCL: 0x80,
      O_TRUNC: 0x200,
      O_APPEND: 0x400,
      O_DIRECTORY: 0x10000,
      O_NOFOLLOW: 0x20000,
      O_CLOEXEC: 0x80000,
      AT_FDCWD: -100,
    };
  }
  return undefined;
}

function loadNative(): Result<NativeLibc, PiNativeSessionFsError> {
  const flags = nativeFlags();
  let libraryPath: string | undefined;
  let errnoName: string | undefined;
  if (platform() === "darwin") {
    libraryPath = "/usr/lib/libSystem.B.dylib";
    errnoName = "__error";
  } else if (platform() === "linux") {
    libraryPath = "libc.so.6";
    errnoName = "__errno_location";
  }
  if (
    flags === undefined ||
    libraryPath === undefined ||
    errnoName === undefined
  ) {
    return err({ type: "unavailable", operation: "open" });
  }

  return Result.fromThrowable(
    () =>
      dlopen(libraryPath, {
        open: { args: ["ptr", "i32", "i32"], returns: "i32" },
        openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
        mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
        close: { args: ["i32"], returns: "i32" },
        fchmod: { args: ["i32", "i32"], returns: "i32" },
        write: { args: ["i32", "ptr", "i32"], returns: "i32" },
        // off_t is 64-bit on Darwin/Linux; count/return stay i32 like write().
        pread: { args: ["i32", "ptr", "i32", "i64"], returns: "i32" },
        fsync: { args: ["i32"], returns: "i32" },
        renameat: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
        unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
        [errnoName]: { args: [], returns: "ptr" },
      }),
    () => ({ type: "unavailable", operation: "open" }) as const,
  )().map((library) => {
    const symbols = library.symbols as unknown as {
      open: (path: unknown, flags: number, mode: number) => number;
      openat: (
        dir: number,
        path: unknown,
        flags: number,
        mode: number,
      ) => number;
      mkdirat: (dir: number, path: unknown, mode: number) => number;
      close: (fd: number) => number;
      fchmod: (fd: number, mode: number) => number;
      write: (fd: number, bytes: unknown, count: number) => number;
      pread: (
        fd: number,
        bytes: unknown,
        count: number,
        offset: bigint | number,
      ) => number;
      fsync: (fd: number) => number;
      renameat: (
        oldDir: number,
        oldName: unknown,
        newDir: number,
        newName: unknown,
      ) => number;
      unlinkat: (dir: number, name: unknown, flags: number) => number;
      [key: string]: unknown;
    };
    return {
      flags,
      open: (path: Uint8Array, openFlags: number, mode: number) =>
        symbols.open(ptr(path), openFlags, mode),
      openat: (
        dir: number,
        path: Uint8Array,
        openFlags: number,
        mode: number,
      ) => symbols.openat(dir, ptr(path), openFlags, mode),
      mkdirat: (dir: number, path: Uint8Array, mode: number) =>
        symbols.mkdirat(dir, ptr(path), mode),
      close: (fd: number) => symbols.close(fd),
      fchmod: (fd: number, mode: number) => symbols.fchmod(fd, mode),
      write: (fd: number, bytes: Uint8Array, count: number) =>
        symbols.write(fd, ptr(bytes), count),
      pread: (fd: number, bytes: Uint8Array, count: number, offset: number) =>
        symbols.pread(fd, ptr(bytes), count, BigInt(offset)),
      fsync: (fd: number) => symbols.fsync(fd),
      renameat: (
        oldDir: number,
        oldName: Uint8Array,
        newDir: number,
        newName: Uint8Array,
      ) => symbols.renameat(oldDir, ptr(oldName), newDir, ptr(newName)),
      unlinkat: (dir: number, name: Uint8Array, unlinkFlags: number) =>
        symbols.unlinkat(dir, ptr(name), unlinkFlags),
      errno: () =>
        read.i32((symbols[errnoName] as () => unknown)() as never, 0),
      dispose: () => library.close(),
    } satisfies NativeLibc;
  });
}

function cstr(value: string): Uint8Array {
  return textEncoder.encode(`${value}\0`);
}

function absoluteSegments(
  path: string,
): Result<readonly string[], PiNativeSessionFsError> {
  if (!isAbsolute(path)) return err({ type: "unsafe-path" });
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (
    segments.some(
      (segment) => segment === "." || segment === ".." || !safeName(segment),
    )
  ) {
    return err({ type: "unsafe-path" });
  }
  return ok(segments);
}

function statFd(
  fd: number,
  kind: "directory" | "file",
  expectedMode: number,
): ResultAsync<NodeIdentity, PiNativeSessionFsError> {
  return ResultAsync.fromThrowable(
    () => Bun.file(fd).stat(),
    () => ({ type: "io" }) as const,
  )().andThen((stat) => {
    if (
      (kind === "directory" && !stat.isDirectory()) ||
      (kind === "file" && !stat.isFile())
    ) {
      return errAsync<NodeIdentity, PiNativeSessionFsError>({
        type: "wrong-kind",
        kind,
      });
    }
    if (
      kind === "file" &&
      (stat as unknown as { nlink?: unknown }).nlink !== 1
    ) {
      return errAsync<NodeIdentity, PiNativeSessionFsError>({
        type: "identity-changed",
      });
    }
    const mode = stat.mode & 0o7777;
    if (mode !== expectedMode) {
      return errAsync<NodeIdentity, PiNativeSessionFsError>({
        type: "permissive-mode",
        kind,
      });
    }
    return okAsync<NodeIdentity, PiNativeSessionFsError>({
      dev: stat.dev,
      ino: stat.ino,
      mode,
    });
  });
}

/**
 * fstat-equivalent identity for a regular 0600 leaf already opened with
 * `O_NOFOLLOW`. Size is included so range readers can detect truncate.
 */
function statFileFd(
  fd: number,
): ResultAsync<FileNodeIdentity, PiNativeSessionFsError> {
  return ResultAsync.fromThrowable(
    () => Bun.file(fd).stat(),
    () => ({ type: "io" }) as const,
  )().andThen((stat) => {
    if (!stat.isFile()) {
      return errAsync<FileNodeIdentity, PiNativeSessionFsError>({
        type: "wrong-kind",
        kind: "file",
      });
    }
    if ((stat as unknown as { nlink?: unknown }).nlink !== 1) {
      return errAsync<FileNodeIdentity, PiNativeSessionFsError>({
        type: "identity-changed",
      });
    }
    const mode = stat.mode & 0o7777;
    if (mode !== 0o600) {
      return errAsync<FileNodeIdentity, PiNativeSessionFsError>({
        type: "permissive-mode",
        kind: "file",
      });
    }
    return okAsync<FileNodeIdentity, PiNativeSessionFsError>({
      dev: stat.dev,
      ino: stat.ino,
      mode,
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeMs),
    });
  });
}

/**
 * Test-only one-shot cap on the next production `pread`. Cleared after use so
 * a forced short read can be followed by a fully checked retry.
 */
let forcedPreadByteLimitForTests: number | undefined;

/** Caps the next OS `pread` byte count, then clears. Production never calls this. */
export function setForcedPreadByteLimitForTests(
  limit: number | undefined,
): void {
  forcedPreadByteLimitForTests = limit;
}

/**
 * One OS `pread`. Callers that need more bytes after a short read must invoke
 * `readRange` again so held-fd and leaf checks re-run around every content
 * read. Helpers must not loop `pread` under one check pair.
 */
function preadOnce(
  libc: NativeLibc,
  fd: number,
  offset: number,
  length: number,
): Result<Uint8Array, PiNativeSessionFsError> {
  if (length === 0) return ok(new Uint8Array());
  const request =
    forcedPreadByteLimitForTests === undefined
      ? length
      : Math.min(length, Math.max(0, forcedPreadByteLimitForTests));
  forcedPreadByteLimitForTests = undefined;
  if (request === 0) return ok(new Uint8Array());
  const buffer = new Uint8Array(request);
  const count = libc.pread(fd, buffer, request, offset);
  if (count < 0) return err({ type: "io" });
  if (count === 0) return ok(new Uint8Array());
  return ok(count === request ? buffer : buffer.subarray(0, count));
}

/**
 * Walks a path without following symlinks. Existing nodes are checked, never
 * repaired. Only a component created by this call is chmoded to 0700.
 */
function openDirectoryChain(
  libc: NativeLibc,
  path: string,
  create: boolean,
  mode: number,
): ResultAsync<number, PiNativeSessionFsError> {
  const segments = absoluteSegments(path);
  if (segments.isErr()) return errAsync(segments.error);

  return ResultAsync.fromThrowable(async () => {
    let current = libc.open(
      cstr("/"),
      libc.flags.O_RDONLY |
        libc.flags.O_DIRECTORY |
        libc.flags.O_NOFOLLOW |
        libc.flags.O_CLOEXEC,
      0,
    );
    if (current < 0) throw { type: "unavailable", operation: "open" };

    try {
      for (const segment of segments.value) {
        let created = false;
        let next = libc.openat(
          current,
          cstr(segment),
          libc.flags.O_RDONLY |
            libc.flags.O_DIRECTORY |
            libc.flags.O_NOFOLLOW |
            libc.flags.O_CLOEXEC,
          0,
        );
        if (next < 0 && create && libc.errno() === ERRNO_ENOENT) {
          const mkdirResult = libc.mkdirat(current, cstr(segment), mode);
          if (mkdirResult !== 0) {
            const mkdirError = libc.errno();
            if (mkdirError !== ERRNO_EEXIST) {
              throw { type: "io" };
            }
          } else {
            created = true;
          }
          next = libc.openat(
            current,
            cstr(segment),
            libc.flags.O_RDONLY |
              libc.flags.O_DIRECTORY |
              libc.flags.O_NOFOLLOW |
              libc.flags.O_CLOEXEC,
            0,
          );
        }
        if (next < 0) {
          throw {
            type:
              libc.errno() === ERRNO_ENOENT ? "missing" : "symlink-rejected",
          };
        }
        if (created && libc.fchmod(next, mode) !== 0) {
          libc.close(next);
          throw { type: "io" };
        }
        libc.close(current);
        current = next;
      }
      return current;
    } catch (cause) {
      libc.close(current);
      throw cause;
    }
  }, mapThrownError)();
}

class BunNativeSessionDirectory implements PiNativeSessionDirectory {
  constructor(
    readonly path: string,
    private readonly libc: NativeLibc,
    private readonly fd: number,
    private readonly bound: NodeIdentity,
  ) {}

  private readonly fileBounds = new Map<string, NodeIdentity>();

  private checkFileIdentity(
    name: string,
    identity: NodeIdentity | undefined,
  ): Result<NodeIdentity | undefined, PiNativeSessionFsError> {
    const bound = this.fileBounds.get(name);
    if (identity === undefined) {
      return bound === undefined
        ? ok(undefined)
        : err({ type: "identity-changed" });
    }
    if (bound !== undefined && !sameIdentity(bound, identity)) {
      return err({ type: "identity-changed" });
    }
    if (bound === undefined) this.fileBounds.set(name, identity);
    return ok(identity);
  }

  identity(): ResultAsync<NodeIdentity, PiNativeSessionFsError> {
    return statFd(this.fd, "directory", 0o700).andThen((held) => {
      if (!sameIdentity(held, this.bound)) {
        return errAsync<NodeIdentity, PiNativeSessionFsError>({
          type: "identity-changed",
        });
      }
      return openDirectoryChain(this.libc, this.path, false, 0o700).andThen(
        (fresh) =>
          statFd(fresh, "directory", 0o700)
            .map((identity) => {
              this.libc.close(fresh);
              return identity;
            })
            .mapErr((error) => {
              this.libc.close(fresh);
              return error;
            })
            .andThen((identity) =>
              sameIdentity(identity, held)
                ? okAsync<NodeIdentity, PiNativeSessionFsError>(held)
                : errAsync<NodeIdentity, PiNativeSessionFsError>({
                    type: "identity-changed",
                  }),
            ),
      );
    });
  }

  private name(name: string): Result<string, PiNativeSessionFsError> {
    return safeName(name) ? ok(name) : err({ type: "unsafe-path" });
  }

  private targetIdentity(
    name: string,
  ): ResultAsync<NodeIdentity | undefined, PiNativeSessionFsError> {
    const fd = this.libc.openat(
      this.fd,
      cstr(name),
      this.libc.flags.O_RDONLY |
        this.libc.flags.O_NOFOLLOW |
        this.libc.flags.O_CLOEXEC,
      0,
    );
    if (fd < 0) {
      return this.libc.errno() === ERRNO_ENOENT
        ? okAsync<NodeIdentity | undefined, PiNativeSessionFsError>(undefined)
        : errAsync({ type: "symlink-rejected" });
    }
    return statFd(fd, "file", 0o600)
      .map((identity) => {
        this.libc.close(fd);
        return identity;
      })
      .mapErr((error) => {
        this.libc.close(fd);
        return error;
      });
  }

  private checkedTargetIdentity(
    name: string,
  ): ResultAsync<NodeIdentity | undefined, PiNativeSessionFsError> {
    return this.targetIdentity(name).andThen((identity) => {
      const checked = this.checkFileIdentity(name, identity);
      return checked.isErr() ? errAsync(checked.error) : okAsync(checked.value);
    });
  }

  /**
   * Opens one regular 0600 leaf through this held directory descriptor and
   * returns an identity-bound handle. Name resolution happens exactly once,
   * here; every later read is a positional `pread` on the returned descriptor,
   * so the validated leaf is never reopened by name and a post-validation
   * rename/symlink swap cannot redirect a read.
   */
  openFile(
    name: string,
  ): ResultAsync<
    PiNativeSessionFileHandle | undefined,
    PiNativeSessionFsError
  > {
    const checked = this.name(name);
    if (checked.isErr()) return errAsync(checked.error);
    return this.identity().andThen(() => {
      const file = this.libc.openat(
        this.fd,
        cstr(checked.value),
        this.libc.flags.O_RDONLY |
          this.libc.flags.O_NOFOLLOW |
          this.libc.flags.O_CLOEXEC,
        0,
      );
      if (file < 0) {
        if (this.libc.errno() === ERRNO_ENOENT) {
          const checkedMissing = this.checkFileIdentity(
            checked.value,
            undefined,
          );
          return checkedMissing.isErr()
            ? errAsync<
                PiNativeSessionFileHandle | undefined,
                PiNativeSessionFsError
              >(checkedMissing.error)
            : okAsync<
                PiNativeSessionFileHandle | undefined,
                PiNativeSessionFsError
              >(undefined);
        }
        return fsErrAsync<PiNativeSessionFileHandle | undefined>({
          type: "symlink-rejected",
        });
      }
      return statFileFd(file)
        .andThen((opened) => {
          const bound = this.checkFileIdentity(checked.value, opened);
          if (bound.isErr()) {
            return errAsync<FileNodeIdentity, PiNativeSessionFsError>(
              bound.error,
            );
          }
          return this.targetIdentity(checked.value).andThen((current) =>
            current !== undefined && sameIdentity(opened, current)
              ? okAsync<FileNodeIdentity, PiNativeSessionFsError>(opened)
              : errAsync<FileNodeIdentity, PiNativeSessionFsError>({
                  type: "identity-changed",
                }),
          );
        })
        .map(
          (opened): PiNativeSessionFileHandle =>
            this.createFileHandle(file, checked.value, opened),
        )
        .mapErr((error) => {
          this.libc.close(file);
          return error;
        });
    });
  }

  /**
   * Wraps one open regular-file descriptor together with the directory
   * descriptor and leaf name it was resolved through.
   *
   * Every read is guarded twice over. The open descriptor is re-`fstat`ed
   * before and after each chunk, so growth, truncation, or in-place mutation
   * fails closed. The directory leaf is separately re-checked with
   * descriptor-relative, no-follow metadata (`openat(dirfd, name,
   * O_NOFOLLOW|O_CLOEXEC)` + `fstat`, i.e. `fstatat` semantics) before and
   * after each chunk, so a rename, atomic replacement or exchange, deletion,
   * symlink swap, hardlink, or mode change of the name fails closed as well.
   * That metadata probe is never read from and is closed immediately; content
   * only ever comes from the descriptor opened once in {@link openFile}.
   */
  private createFileHandle(
    fd: number,
    name: string,
    openedIdentity: FileNodeIdentity,
  ): PiNativeSessionFileHandle {
    let closed = false;
    const libc = this.libc;
    const opened = toFileStat(openedIdentity);
    const directoryIdentity = (): ResultAsync<
      NodeIdentity,
      PiNativeSessionFsError
    > => this.identity();
    /**
     * Metadata-only, descriptor-relative, no-follow check that `name` still
     * resolves to the exact node this handle holds open, with the same mode
     * and a single link. The probe descriptor is closed by
     * {@link targetIdentity} and is never used for content.
     */
    const verifyLeaf = (): ResultAsync<void, PiNativeSessionFsError> =>
      this.targetIdentity(name).andThen((current) =>
        current !== undefined &&
        sameIdentity(current, openedIdentity) &&
        current.mode === openedIdentity.mode
          ? okAsync<void, PiNativeSessionFsError>(undefined)
          : errAsync<void, PiNativeSessionFsError>({
              type: "identity-changed",
            }),
      );
    return {
      identity: opened,
      stat(): ResultAsync<PiNativeSessionFileStat, PiNativeSessionFsError> {
        if (closed) {
          return fsErrAsync<PiNativeSessionFileStat>({
            type: "unavailable",
            operation: "open",
          });
        }
        return verifyLeaf().andThen(() => statFileFd(fd).map(toFileStat));
      },
      readRange(
        offset: number,
        length: number,
      ): ResultAsync<PiNativeSessionFileRange, PiNativeSessionFsError> {
        if (closed) {
          return fsErrAsync<PiNativeSessionFileRange>({
            type: "unavailable",
            operation: "open",
          });
        }
        const range = validateRange(offset, length);
        if (range.isErr()) return errAsync(range.error);
        return ResultAsync.fromThrowable(async () => {
          await unwrapResult(directoryIdentity());
          await unwrapResult(verifyLeaf());
          const before = toFileStat(await unwrapResult(statFileFd(fd)));
          if (!sameFileStat(before, opened)) {
            throw { type: "identity-changed" } satisfies PiNativeSessionFsError;
          }
          const bytes = preadOnce(libc, fd, offset, length);
          if (bytes.isErr()) throw bytes.error;
          const after = toFileStat(await unwrapResult(statFileFd(fd)));
          if (!sameFileStat(after, opened)) {
            throw { type: "identity-changed" } satisfies PiNativeSessionFsError;
          }
          await unwrapResult(verifyLeaf());
          await unwrapResult(directoryIdentity());
          return {
            identity: opened,
            bytes: bytes.value,
            offset,
          } satisfies PiNativeSessionFileRange;
        }, mapThrownError)();
      },
      close(): void {
        if (closed) return;
        closed = true;
        libc.close(fd);
      },
    };
  }

  statFile(
    name: string,
  ): ResultAsync<PiNativeSessionFileStat | undefined, PiNativeSessionFsError> {
    const checked = this.name(name);
    if (checked.isErr()) return errAsync(checked.error);
    return this.identity().andThen(() => {
      const file = this.libc.openat(
        this.fd,
        cstr(checked.value),
        this.libc.flags.O_RDONLY |
          this.libc.flags.O_NOFOLLOW |
          this.libc.flags.O_CLOEXEC,
        0,
      );
      if (file < 0) {
        if (this.libc.errno() === ERRNO_ENOENT) {
          const checkedMissing = this.checkFileIdentity(
            checked.value,
            undefined,
          );
          return checkedMissing.isErr()
            ? errAsync<
                PiNativeSessionFileStat | undefined,
                PiNativeSessionFsError
              >(checkedMissing.error)
            : okAsync<
                PiNativeSessionFileStat | undefined,
                PiNativeSessionFsError
              >(undefined);
        }
        return fsErrAsync<PiNativeSessionFileStat | undefined>({
          type: "symlink-rejected",
        });
      }
      return statFileFd(file)
        .map((fileIdentity) => {
          this.libc.close(file);
          return fileIdentity;
        })
        .mapErr((error) => {
          this.libc.close(file);
          return error;
        })
        .andThen((fileIdentity) => {
          const bound = this.checkFileIdentity(checked.value, fileIdentity);
          if (bound.isErr()) return errAsync(bound.error);
          return this.identity()
            .andThen(() => this.targetIdentity(checked.value))
            .andThen((current) =>
              current !== undefined && sameIdentity(fileIdentity, current)
                ? okAsync<PiNativeSessionFileStat, PiNativeSessionFsError>(
                    toFileStat(fileIdentity),
                  )
                : errAsync<PiNativeSessionFileStat, PiNativeSessionFsError>({
                    type: "identity-changed",
                  }),
            );
        });
    });
  }

  readFileRange(
    name: string,
    offset: number,
    length: number,
  ): ResultAsync<PiNativeSessionFileRange | undefined, PiNativeSessionFsError> {
    const range = validateRange(offset, length);
    if (range.isErr()) return errAsync(range.error);
    const checked = this.name(name);
    if (checked.isErr()) return errAsync(checked.error);
    return this.identity().andThen(() => {
      const file = this.libc.openat(
        this.fd,
        cstr(checked.value),
        this.libc.flags.O_RDONLY |
          this.libc.flags.O_NOFOLLOW |
          this.libc.flags.O_CLOEXEC,
        0,
      );
      if (file < 0) {
        if (this.libc.errno() === ERRNO_ENOENT) {
          const checkedMissing = this.checkFileIdentity(
            checked.value,
            undefined,
          );
          return checkedMissing.isErr()
            ? errAsync<
                PiNativeSessionFileRange | undefined,
                PiNativeSessionFsError
              >(checkedMissing.error)
            : okAsync<
                PiNativeSessionFileRange | undefined,
                PiNativeSessionFsError
              >(undefined);
        }
        return fsErrAsync<PiNativeSessionFileRange | undefined>({
          type: "symlink-rejected",
        });
      }
      return ResultAsync.fromThrowable(async () => {
        const before = await unwrapResult(statFileFd(file));
        const bound = this.checkFileIdentity(checked.value, before);
        if (bound.isErr()) throw bound.error;
        const bytes = preadOnce(this.libc, file, offset, length);
        if (bytes.isErr()) throw bytes.error;
        const after = await unwrapResult(statFileFd(file));
        if (!sameFileStat(toFileStat(before), toFileStat(after))) {
          throw { type: "identity-changed" } satisfies PiNativeSessionFsError;
        }
        await unwrapResult(this.identity());
        const current = await unwrapResult(this.targetIdentity(checked.value));
        if (current === undefined || !sameIdentity(before, current)) {
          throw { type: "identity-changed" } satisfies PiNativeSessionFsError;
        }
        return {
          identity: toFileStat(before),
          bytes: bytes.value,
          offset,
        } satisfies PiNativeSessionFileRange;
      }, mapThrownError)()
        .map((result) => {
          this.libc.close(file);
          return result;
        })
        .mapErr((error) => {
          this.libc.close(file);
          return error;
        });
    });
  }

  private appendValidated(
    name: string,
    bytes: Uint8Array,
  ): ResultAsync<void, PiNativeSessionFsError> {
    return ResultAsync.fromThrowable(async () => {
      let fd = this.libc.openat(
        this.fd,
        cstr(name),
        this.libc.flags.O_RDWR |
          this.libc.flags.O_APPEND |
          this.libc.flags.O_NOFOLLOW |
          this.libc.flags.O_CLOEXEC,
        0,
      );
      let created = false;
      if (fd < 0) {
        if (this.libc.errno() !== ERRNO_ENOENT)
          throw { type: "symlink-rejected" };
        fd = this.libc.openat(
          this.fd,
          cstr(name),
          this.libc.flags.O_RDWR |
            this.libc.flags.O_CREAT |
            this.libc.flags.O_EXCL |
            this.libc.flags.O_APPEND |
            this.libc.flags.O_NOFOLLOW |
            this.libc.flags.O_CLOEXEC,
          0,
        );
        if (fd < 0) throw { type: "io" };
        created = true;
        if (this.libc.fchmod(fd, 0o600) !== 0) {
          this.libc.close(fd);
          this.libc.unlinkat(this.fd, cstr(name), 0);
          throw { type: "io" };
        }
      }

      let closed = false;
      try {
        const fileIdentity = await unwrapResult(statFd(fd, "file", 0o600));
        const checkedFile = this.checkFileIdentity(name, fileIdentity);
        if (checkedFile.isErr()) throw checkedFile.error;
        let offset = 0;
        while (offset < bytes.length) {
          const count = this.libc.write(
            fd,
            bytes.subarray(offset),
            bytes.length - offset,
          );
          if (count <= 0) throw { type: "io" };
          offset += count;
        }
        if (this.libc.fsync(fd) !== 0) throw { type: "io" };
        if (this.libc.close(fd) !== 0) throw { type: "io" };
        closed = true;

        await unwrapResult(this.identity());
        const current = await unwrapResult(this.targetIdentity(name));
        if (current === undefined || !sameIdentity(fileIdentity, current)) {
          throw { type: "identity-changed" };
        }
      } finally {
        if (!closed) this.libc.close(fd);
        if (created && !closed) this.libc.unlinkat(this.fd, cstr(name), 0);
      }
    }, mapThrownError)().map(() => undefined);
  }

  appendFile(
    name: string,
    bytes: Uint8Array,
    mode: number,
  ): ResultAsync<void, PiNativeSessionFsError> {
    const checked = this.name(name);
    if (checked.isErr()) return errAsync(checked.error);
    if (mode !== 0o600) {
      return errAsync({ type: "permissive-mode", kind: "file" });
    }
    return this.identity().andThen(() =>
      this.appendValidated(checked.value, bytes),
    );
  }

  createExclusiveFile(
    name: string,
    bytes: Uint8Array,
    mode: number,
  ): ResultAsync<void, PiNativeSessionFsError> {
    const checked = this.name(name);
    if (checked.isErr()) return errAsync(checked.error);
    if (mode !== 0o600) {
      return errAsync({ type: "permissive-mode", kind: "file" });
    }
    return this.identity().andThen(() =>
      this.createExclusiveValidated(checked.value, bytes),
    );
  }

  private createExclusiveValidated(
    name: string,
    bytes: Uint8Array,
  ): ResultAsync<void, PiNativeSessionFsError> {
    return ResultAsync.fromThrowable(async () => {
      const fd = this.libc.openat(
        this.fd,
        cstr(name),
        this.libc.flags.O_RDWR |
          this.libc.flags.O_CREAT |
          this.libc.flags.O_EXCL |
          this.libc.flags.O_NOFOLLOW |
          this.libc.flags.O_CLOEXEC,
        0o600,
      );
      if (fd < 0) {
        if (this.libc.errno() === ERRNO_EEXIST) {
          throw { type: "already-exists" };
        }
        throw { type: "symlink-rejected" };
      }

      let closed = false;
      try {
        if (this.libc.fchmod(fd, 0o600) !== 0) {
          throw { type: "io" };
        }
        const fileIdentity = await unwrapResult(statFd(fd, "file", 0o600));
        const checkedFile = this.checkFileIdentity(name, fileIdentity);
        if (checkedFile.isErr()) throw checkedFile.error;
        let offset = 0;
        while (offset < bytes.length) {
          const count = this.libc.write(
            fd,
            bytes.subarray(offset),
            bytes.length - offset,
          );
          if (count <= 0) throw { type: "io" };
          offset += count;
        }
        if (this.libc.fsync(fd) !== 0) throw { type: "io" };
        if (this.libc.close(fd) !== 0) throw { type: "io" };
        closed = true;

        await unwrapResult(this.identity());
        const current = await unwrapResult(this.targetIdentity(name));
        if (current === undefined || !sameIdentity(fileIdentity, current)) {
          throw { type: "identity-changed" };
        }
      } finally {
        if (!closed) {
          this.libc.close(fd);
          this.libc.unlinkat(this.fd, cstr(name), 0);
        }
      }
    }, mapThrownError)().map(() => undefined);
  }

  deleteFile(name: string): ResultAsync<void, PiNativeSessionFsError> {
    const checked = this.name(name);
    if (checked.isErr()) return errAsync(checked.error);
    return this.identity()
      .andThen(() => this.checkedTargetIdentity(checked.value))
      .andThen((target) => {
        if (target === undefined) return fsVoidAsync();
        return this.identity()
          .andThen(() => this.targetIdentity(checked.value))
          .andThen((current) => {
            if (current === undefined || !sameIdentity(target, current)) {
              return fsErrAsync<void>({ type: "identity-changed" });
            }
            const result = this.libc.unlinkat(this.fd, cstr(checked.value), 0);
            if (result === 0 || this.libc.errno() === ERRNO_ENOENT) {
              this.fileBounds.delete(checked.value);
              return fsVoidAsync();
            }
            return fsErrAsync<void>({ type: "io" });
          });
      });
  }

  sync(): ResultAsync<void, PiNativeSessionFsError> {
    return this.identity().andThen(() =>
      this.libc.fsync(this.fd) === 0
        ? fsVoidAsync()
        : fsErrAsync<void>({ type: "io" }),
    );
  }

  close(): void {
    this.libc.close(this.fd);
    this.libc.dispose();
  }
}

class BunPiNativeSessionFs implements PiNativeSessionFsPort {
  openDirectory(
    path: string,
    create: boolean,
  ): ResultAsync<PiNativeSessionDirectory, PiNativeSessionFsError> {
    const loaded = loadNative();
    if (loaded.isErr()) return errAsync(loaded.error);
    return openDirectoryChain(loaded.value, path, create, 0o700)
      .andThen((fd) =>
        statFd(fd, "directory", 0o700)
          .map(
            (identity) =>
              new BunNativeSessionDirectory(path, loaded.value, fd, identity),
          )
          .mapErr((error) => {
            loaded.value.close(fd);
            return error;
          }),
      )
      .mapErr((error) => {
        loaded.value.dispose();
        return error;
      });
  }
}

export { BunPiNativeSessionFs };

interface MemoryFileData {
  identity: NodeIdentity;
  mode: number;
  symlink: boolean;
  hardlink?: boolean;
  kind: "file" | "directory";
  bytes: Uint8Array;
  /** Monotonic stand-in for `mtimeMs`; bumped on every content mutation. */
  mtimeMs: number;
}

interface MemoryDirectoryData {
  readonly path: string;
  identity: NodeIdentity;
  symlink: boolean;
  files: Map<string, MemoryFileData>;
}

let memoryInode = 10_000;
function nextMemoryIdentity(mode = 0o700): NodeIdentity {
  memoryInode += 1;
  return { dev: 1, ino: memoryInode, mode };
}

let memoryMtime = 1_000;
function nextMemoryMtime(): number {
  memoryMtime += 1;
  return memoryMtime;
}

export class MemoryPiNativeSessionFs implements PiNativeSessionFsPort {
  private readonly directories = new Map<string, MemoryDirectoryData>();
  private readonly replaced = new Set<string>();
  private readonly postValidationSwaps = new Map<
    string,
    "replacement" | "rename"
  >();
  private readonly midReadTruncates = new Map<string, number>();
  private readonly midReadGrowths = new Map<string, number>();
  private readonly midReadRewrites = new Map<string, number>();
  private readonly midReadLeafSwaps = new Map<
    string,
    "replacement" | "rename" | "symlink" | "hardlink"
  >();
  /**
   * One-shot caps on range-read returned byte counts. Each entry may require
   * `offset >= minOffset` so paging tests can short a body window without
   * consuming the cap on the header scan at offset 0.
   */
  private readonly midReadShortCaps = new Map<
    string,
    { maxBytes: number; minOffset: number }
  >();
  private readonly exclusiveCreateFailures = new Map<
    string,
    PiNativeSessionFsError
  >();
  private readonly appendFailures = new Map<
    string,
    { remainingSuccesses: number; error: PiNativeSessionFsError }[]
  >();
  private readonly deleteFailures = new Map<string, PiNativeSessionFsError>();

  private midReadKey(path: string, name: string): string {
    return `${path}\0${name}`;
  }

  /**
   * Applies any queued mid-read mutation to `file` between identity capture
   * and re-check, so tests can grow or truncate a leaf during one read.
   */
  private applyMidReadMutation(
    path: string,
    name: string,
    file: MemoryFileData,
  ): void {
    const key = this.midReadKey(path, name);
    const truncateTo = this.midReadTruncates.get(key);
    if (truncateTo !== undefined) {
      this.midReadTruncates.delete(key);
      file.bytes = file.bytes.slice(0, Math.max(0, truncateTo));
      file.mtimeMs = nextMemoryMtime();
    }
    const growBy = this.midReadGrowths.get(key);
    if (growBy !== undefined) {
      this.midReadGrowths.delete(key);
      const grown = new Uint8Array(file.bytes.length + Math.max(0, growBy));
      grown.set(file.bytes);
      grown.fill(0x0a, file.bytes.length);
      file.bytes = grown;
      file.mtimeMs = nextMemoryMtime();
    }
    const rewrite = this.midReadRewrites.get(key);
    if (rewrite !== undefined) {
      this.midReadRewrites.delete(key);
      file.bytes = file.bytes.slice();
      file.bytes.fill(rewrite);
      file.mtimeMs = nextMemoryMtime();
    }
  }

  /**
   * Consumes a one-shot short-read cap when present and the read offset meets
   * its minimum. When a short cap fires, mid-read mutations and leaf swaps stay
   * queued for the next range call so a forced short read can succeed and the
   * follow-up check pair can reject.
   */
  private takeForcedShortCap(
    path: string,
    name: string,
    offset: number,
  ): number | undefined {
    const key = this.midReadKey(path, name);
    const cap = this.midReadShortCaps.get(key);
    if (cap === undefined) return undefined;
    if (offset < cap.minOffset) return undefined;
    this.midReadShortCaps.delete(key);
    return Math.max(0, cap.maxBytes);
  }

  private applyPostValidationSwap(path: string, name: string): void {
    const key = this.midReadKey(path, name);
    const swap = this.postValidationSwaps.get(key);
    if (swap === undefined) return;
    this.postValidationSwaps.delete(key);
    const directory = this.directories.get(path);
    const file = directory?.files.get(name);
    if (directory === undefined || file === undefined) return;
    if (swap === "rename") {
      directory.files.delete(name);
      return;
    }
    directory.files.set(name, {
      ...file,
      identity: nextMemoryIdentity(file.mode),
    });
  }

  /**
   * Swaps, renames, symlinks, or hardlinks the directory leaf between the two
   * leaf checks that surround one in-flight range read, so tests can prove the
   * post-read leaf verification rejects it.
   */
  private applyMidReadLeafSwap(path: string, name: string): void {
    const key = this.midReadKey(path, name);
    const swap = this.midReadLeafSwaps.get(key);
    if (swap === undefined) return;
    this.midReadLeafSwaps.delete(key);
    const directory = this.directories.get(path);
    const file = directory?.files.get(name);
    if (directory === undefined || file === undefined) return;
    if (swap === "rename") {
      directory.files.delete(name);
      return;
    }
    if (swap === "hardlink") {
      file.hardlink = true;
      return;
    }
    directory.files.set(name, {
      ...file,
      identity: nextMemoryIdentity(file.mode),
      symlink: swap === "symlink",
      bytes: swap === "symlink" ? new Uint8Array() : file.bytes.slice(),
    });
  }

  openDirectory(
    path: string,
    create: boolean,
  ): ResultAsync<PiNativeSessionDirectory, PiNativeSessionFsError> {
    if (!isAbsolute(path)) return errAsync({ type: "unsafe-path" });
    let data = this.directories.get(path);
    if (data === undefined && create) {
      data = {
        path,
        identity: nextMemoryIdentity(),
        symlink: false,
        files: new Map(),
      };
      this.directories.set(path, data);
    }
    if (data === undefined) return errAsync({ type: "missing" });
    if (data.symlink) return errAsync({ type: "symlink-rejected" });
    const bound = data.identity;
    const fs = this;
    const fileBounds = new Map<string, NodeIdentity>();
    let closed = false;

    const checkFileIdentity = (
      name: string,
      identity: NodeIdentity | undefined,
    ): Result<NodeIdentity | undefined, PiNativeSessionFsError> => {
      const known = fileBounds.get(name);
      if (identity === undefined) {
        return known === undefined
          ? ok(undefined)
          : err({ type: "identity-changed" });
      }
      if (known !== undefined && !sameIdentity(known, identity)) {
        return err({ type: "identity-changed" });
      }
      if (known === undefined) fileBounds.set(name, identity);
      return ok(identity);
    };

    const memoryFileStat = (file: MemoryFileData): PiNativeSessionFileStat => ({
      dev: file.identity.dev,
      ino: file.identity.ino,
      size: file.bytes.length,
      mtimeMs: file.mtimeMs,
    });

    const handle: PiNativeSessionDirectory & {
      identity(): ResultAsync<NodeIdentity, PiNativeSessionFsError>;
    } = {
      path,
      identity(): ResultAsync<NodeIdentity, PiNativeSessionFsError> {
        if (closed) return errAsync({ type: "unavailable", operation: "open" });
        const current = fs.directories.get(path);
        if (current === undefined || current.symlink) {
          return errAsync({ type: "symlink-rejected" });
        }
        if (fs.replaced.has(path) || !sameIdentity(current.identity, bound)) {
          return errAsync({ type: "identity-changed" });
        }
        if (current.identity.mode !== 0o700) {
          return errAsync({ type: "permissive-mode", kind: "directory" });
        }
        return okAsync(current.identity);
      },
      openFile(
        name,
      ): ResultAsync<
        PiNativeSessionFileHandle | undefined,
        PiNativeSessionFsError
      > {
        if (!safeName(name)) return errAsync({ type: "unsafe-path" });
        const directoryIdentity = (): ResultAsync<
          NodeIdentity,
          PiNativeSessionFsError
        > => this.identity();
        return directoryIdentity().andThen(() => {
          const file = fs.directories.get(path)?.files.get(name);
          if (file === undefined) {
            const checkedMissing = checkFileIdentity(name, undefined);
            return checkedMissing.isErr()
              ? errAsync<
                  PiNativeSessionFileHandle | undefined,
                  PiNativeSessionFsError
                >(checkedMissing.error)
              : okAsync<
                  PiNativeSessionFileHandle | undefined,
                  PiNativeSessionFsError
                >(undefined);
          }
          const checked = validateMemoryFile(file);
          if (checked.isErr()) return errAsync(checked.error);
          const boundFile = checkFileIdentity(name, file.identity);
          if (boundFile.isErr()) return errAsync(boundFile.error);
          const opened = memoryFileStat(file);
          // Name resolution ends here. The handle keeps the resolved node and
          // the leaf name it came from, so later reads both read the resolved
          // node and re-check that the name still points at it.
          fs.applyPostValidationSwap(path, name);
          let fileClosed = false;
          /**
           * Mirrors the production no-follow, directory-relative leaf probe:
           * the name must still resolve to this exact node, unswapped,
           * unrenamed, not a symlink, not hardlinked, same mode.
           */
          const verifyLeaf = (): Result<void, PiNativeSessionFsError> => {
            const current = fs.directories.get(path)?.files.get(name);
            if (current === undefined) return err({ type: "identity-changed" });
            const validated = validateMemoryFile(current);
            if (validated.isErr()) return err(validated.error);
            return sameIdentity(current.identity, file.identity) &&
              current.mode === file.mode
              ? ok(undefined)
              : err({ type: "identity-changed" });
          };
          const handleForFile: PiNativeSessionFileHandle = {
            identity: opened,
            stat(): ResultAsync<
              PiNativeSessionFileStat,
              PiNativeSessionFsError
            > {
              if (fileClosed) {
                return fsErrAsync<PiNativeSessionFileStat>({
                  type: "unavailable",
                  operation: "open",
                });
              }
              return directoryIdentity().andThen(() => {
                const leaf = verifyLeaf();
                return leaf.isErr()
                  ? fsErrAsync<PiNativeSessionFileStat>(leaf.error)
                  : okAsync<PiNativeSessionFileStat, PiNativeSessionFsError>(
                      memoryFileStat(file),
                    );
              });
            },
            readRange(
              offset,
              length,
            ): ResultAsync<PiNativeSessionFileRange, PiNativeSessionFsError> {
              if (fileClosed) {
                return fsErrAsync<PiNativeSessionFileRange>({
                  type: "unavailable",
                  operation: "open",
                });
              }
              const range = validateRange(offset, length);
              if (range.isErr()) return errAsync(range.error);
              return directoryIdentity().andThen(() => {
                const validated = validateMemoryFile(file);
                if (validated.isErr()) return errAsync(validated.error);
                const leafBefore = verifyLeaf();
                if (leafBefore.isErr()) {
                  return fsErrAsync<PiNativeSessionFileRange>(leafBefore.error);
                }
                // One content read per check pair. A forced short cap defers
                // mutations/swaps so the next readRange re-checks before bytes.
                const shortCap = fs.takeForcedShortCap(path, name, offset);
                if (shortCap === undefined) {
                  fs.applyMidReadLeafSwap(path, name);
                  fs.applyMidReadMutation(path, name, file);
                }
                if (!sameFileStat(memoryFileStat(file), opened)) {
                  return fsErrAsync<PiNativeSessionFileRange>({
                    type: "identity-changed",
                  });
                }
                const leafAfter = verifyLeaf();
                if (leafAfter.isErr()) {
                  return fsErrAsync<PiNativeSessionFileRange>(leafAfter.error);
                }
                const start = Math.min(offset, file.bytes.length);
                const cappedLength =
                  shortCap === undefined ? length : Math.min(length, shortCap);
                const end = Math.min(offset + cappedLength, file.bytes.length);
                return okAsync<
                  PiNativeSessionFileRange,
                  PiNativeSessionFsError
                >({
                  identity: opened,
                  bytes: file.bytes.slice(start, end),
                  offset,
                });
              });
            },
            close(): void {
              fileClosed = true;
            },
          };
          return okAsync<
            PiNativeSessionFileHandle | undefined,
            PiNativeSessionFsError
          >(handleForFile);
        });
      },
      statFile(
        name,
      ): ResultAsync<
        PiNativeSessionFileStat | undefined,
        PiNativeSessionFsError
      > {
        if (!safeName(name)) return errAsync({ type: "unsafe-path" });
        return this.identity().andThen(() => {
          const file = fs.directories.get(path)?.files.get(name);
          if (file === undefined) {
            const checkedMissing = checkFileIdentity(name, undefined);
            return checkedMissing.isErr()
              ? errAsync<
                  PiNativeSessionFileStat | undefined,
                  PiNativeSessionFsError
                >(checkedMissing.error)
              : okAsync<PiNativeSessionFileStat | undefined>(undefined);
          }
          const checked = validateMemoryFile(file);
          if (checked.isErr()) return errAsync(checked.error);
          const boundFile = checkFileIdentity(name, file.identity);
          if (boundFile.isErr()) return errAsync(boundFile.error);
          const identity = memoryFileStat(file);
          fs.applyPostValidationSwap(path, name);
          return this.identity().andThen(() => {
            const current = fs.directories.get(path)?.files.get(name);
            return current !== undefined &&
              sameIdentity(current.identity, file.identity) &&
              current.bytes.length === identity.size
              ? okAsync<PiNativeSessionFileStat, PiNativeSessionFsError>(
                  identity,
                )
              : fsErrAsync<PiNativeSessionFileStat>({
                  type: "identity-changed",
                });
          });
        });
      },
      readFileRange(
        name,
        offset,
        length,
      ): ResultAsync<
        PiNativeSessionFileRange | undefined,
        PiNativeSessionFsError
      > {
        const range = validateRange(offset, length);
        if (range.isErr()) return errAsync(range.error);
        if (!safeName(name)) return errAsync({ type: "unsafe-path" });
        return this.identity().andThen(() => {
          const file = fs.directories.get(path)?.files.get(name);
          if (file === undefined) {
            const checkedMissing = checkFileIdentity(name, undefined);
            return checkedMissing.isErr()
              ? errAsync<
                  PiNativeSessionFileRange | undefined,
                  PiNativeSessionFsError
                >(checkedMissing.error)
              : okAsync<PiNativeSessionFileRange | undefined>(undefined);
          }
          const checked = validateMemoryFile(file);
          if (checked.isErr()) return errAsync(checked.error);
          const before = memoryFileStat(file);
          const boundFile = checkFileIdentity(name, file.identity);
          if (boundFile.isErr()) return errAsync(boundFile.error);
          fs.applyPostValidationSwap(path, name);

          fs.applyMidReadMutation(path, name, file);

          const start = Math.min(offset, file.bytes.length);
          const end = Math.min(offset + length, file.bytes.length);
          const bytes = file.bytes.slice(start, end);

          const current = fs.directories.get(path)?.files.get(name);
          if (
            current === undefined ||
            !sameIdentity(current.identity, file.identity) ||
            current.bytes.length !== before.size
          ) {
            return fsErrAsync<PiNativeSessionFileRange>({
              type: "identity-changed",
            });
          }
          return this.identity().map(() => ({
            identity: before,
            bytes,
            offset,
          }));
        });
      },
      appendFile(name, bytes, mode) {
        if (!safeName(name)) return fsErrAsync<void>({ type: "unsafe-path" });
        if (mode !== 0o600) {
          return fsErrAsync<void>({
            type: "permissive-mode",
            kind: "file",
          });
        }
        const forced = fs.takeAppendFailure(path, name);
        if (forced !== undefined) return fsErrAsync<void>(forced);
        return this.identity().andThen(() => {
          const current = fs.directories.get(path);
          if (current === undefined) {
            return fsErrAsync<void>({
              type: "unavailable",
              operation: "write",
            });
          }
          const existing = current.files.get(name);
          if (existing === undefined) {
            const created: MemoryFileData = {
              identity: nextMemoryIdentity(0o600),
              mode: 0o600,
              symlink: false,
              kind: "file",
              bytes: new Uint8Array(bytes),
              mtimeMs: nextMemoryMtime(),
            };
            current.files.set(name, created);
            fileBounds.set(name, created.identity);
          } else {
            const checked = validateMemoryFile(existing);
            if (checked.isErr()) return errAsync(checked.error);
            const known = checkFileIdentity(name, existing.identity);
            if (known.isErr()) return errAsync(known.error);
            const next = new Uint8Array(existing.bytes.length + bytes.length);
            next.set(existing.bytes);
            next.set(bytes, existing.bytes.length);
            existing.bytes = next;
            existing.mtimeMs = nextMemoryMtime();
          }
          return this.identity().map<void>(() => undefined);
        });
      },
      sync() {
        return this.identity().map<void>(() => undefined);
      },
      createExclusiveFile(name, bytes, mode) {
        if (!safeName(name)) return fsErrAsync<void>({ type: "unsafe-path" });
        if (mode !== 0o600) {
          return fsErrAsync<void>({
            type: "permissive-mode",
            kind: "file",
          });
        }
        return this.identity().andThen(() => {
          const key = fs.midReadKey(path, name);
          const forced = fs.exclusiveCreateFailures.get(key);
          if (forced !== undefined) {
            fs.exclusiveCreateFailures.delete(key);
            return fsErrAsync<void>(forced);
          }
          const current = fs.directories.get(path);
          if (current === undefined) {
            return fsErrAsync<void>({
              type: "unavailable",
              operation: "write",
            });
          }
          const existing = current.files.get(name);
          if (existing !== undefined) {
            if (existing.symlink) {
              return fsErrAsync<void>({ type: "symlink-rejected" });
            }
            return fsErrAsync<void>({ type: "already-exists" });
          }
          const created: MemoryFileData = {
            identity: nextMemoryIdentity(0o600),
            mode: 0o600,
            symlink: false,
            kind: "file",
            bytes: new Uint8Array(bytes),
            mtimeMs: nextMemoryMtime(),
          };
          current.files.set(name, created);
          fileBounds.set(name, created.identity);
          return this.identity().map<void>(() => undefined);
        });
      },
      deleteFile(name) {
        if (!safeName(name)) return fsErrAsync<void>({ type: "unsafe-path" });
        const forced = fs.takeDeleteFailure(path, name);
        if (forced !== undefined) return fsErrAsync<void>(forced);
        return this.identity().andThen(() => {
          const current = fs.directories.get(path);
          if (current === undefined) {
            return fsErrAsync<void>({
              type: "unavailable",
              operation: "delete",
            });
          }
          const existing = current.files.get(name);
          if (existing === undefined) return fsVoidAsync();
          const checked = validateMemoryFile(existing);
          if (checked.isErr()) return errAsync(checked.error);
          const known = checkFileIdentity(name, existing.identity);
          if (known.isErr()) return errAsync(known.error);
          current.files.delete(name);
          fileBounds.delete(name);
          return fsVoidAsync();
        });
      },
      close() {
        closed = true;
      },
    };
    return okAsync(handle);
  }

  simulateDirectorySymlink(path: string): void {
    const directory = this.directories.get(path);
    if (directory) directory.symlink = true;
  }

  simulateDirectoryReplacement(path: string): void {
    this.replaced.add(path);
  }

  simulatePermissiveDirectory(path: string): void {
    const directory = this.directories.get(path);
    if (directory) {
      directory.identity = { ...directory.identity, mode: 0o755 };
    }
  }

  simulateFileSymlink(path: string, name: string): void {
    const directory = this.directories.get(path);
    if (directory) {
      directory.files.set(name, {
        identity: nextMemoryIdentity(0o600),
        mode: 0o600,
        symlink: true,
        kind: "file",
        bytes: new Uint8Array(),
        mtimeMs: nextMemoryMtime(),
      });
    }
  }

  simulateFileReplacement(path: string, name: string): void {
    const directory = this.directories.get(path);
    const existing = directory?.files.get(name);
    if (directory && existing) {
      existing.identity = nextMemoryIdentity(existing.mode);
    }
  }

  simulateExternalHardlink(path: string, name: string): void {
    const file = this.directories.get(path)?.files.get(name);
    if (file) file.hardlink = true;
  }

  simulateFileRename(path: string, name: string): void {
    this.directories.get(path)?.files.delete(name);
  }

  /** Swap a leaf after its first identity check inside a read operation. */
  simulatePostValidationSwap(
    path: string,
    name: string,
    swap: "replacement" | "rename",
  ): void {
    this.postValidationSwaps.set(this.midReadKey(path, name), swap);
  }

  /**
   * Swap the directory leaf during one in-flight range read, after the
   * pre-read leaf check and before the post-read leaf check.
   */
  simulateMidReadLeafSwap(
    path: string,
    name: string,
    swap: "replacement" | "rename" | "symlink" | "hardlink",
  ): void {
    this.midReadLeafSwaps.set(this.midReadKey(path, name), swap);
  }

  /** Truncate a leaf between identity capture and re-check inside one range read. */
  simulateMidReadTruncate(path: string, name: string, size: number): void {
    this.midReadTruncates.set(this.midReadKey(path, name), size);
  }

  /** Append `bytes` newline bytes to a leaf during one in-flight range read. */
  simulateMidReadGrowth(path: string, name: string, bytes: number): void {
    this.midReadGrowths.set(this.midReadKey(path, name), bytes);
  }

  /**
   * Rewrite a leaf in place, same size, during one in-flight range read. Only
   * `mtimeMs` moves, so this proves size-only checks are not sufficient.
   */
  simulateMidReadRewrite(path: string, name: string, fill = 0x62): void {
    this.midReadRewrites.set(this.midReadKey(path, name), fill);
  }

  /**
   * Force the next open-file `readRange` for `path`/`name` at
   * `offset >= minOffset` to return at most `maxBytes`, even when more content
   * is available. Queued mid-read mutations and leaf swaps stay deferred until
   * the following range call so a short read can succeed and the retry's check
   * pair can reject. Pass `minOffset > 0` to spare the header scan at offset 0.
   */
  simulateForcedShortRead(
    path: string,
    name: string,
    maxBytes: number,
    minOffset = 0,
  ): void {
    this.midReadShortCaps.set(this.midReadKey(path, name), {
      maxBytes,
      minOffset,
    });
  }

  simulateFileTruncate(path: string, name: string, size: number): void {
    const file = this.directories.get(path)?.files.get(name);
    if (file) {
      file.bytes = file.bytes.slice(0, Math.max(0, size));
      file.mtimeMs = nextMemoryMtime();
    }
  }

  simulatePermissiveFile(path: string, name: string): void {
    const file = this.directories.get(path)?.files.get(name);
    if (file) {
      file.mode = 0o644;
      file.identity = { ...file.identity, mode: 0o644 };
    }
  }

  /**
   * Forces the next {@link PiNativeSessionDirectory.createExclusiveFile} for
   * `path`/`name` to fail with the given error (default `already-exists`).
   */
  simulateExclusiveCreateFailure(
    path: string,
    name: string,
    error: PiNativeSessionFsError = { type: "already-exists" },
  ): void {
    this.exclusiveCreateFailures.set(this.midReadKey(path, name), error);
  }

  /**
   * Forces a later {@link PiNativeSessionDirectory.appendFile} for
   * `path`/`name` to fail. `afterSuccesses` lets a test keep the first N
   * appends (intent, then a later completion) and fail a specific one.
   */
  simulateAppendFailure(
    path: string,
    name: string,
    error: PiNativeSessionFsError,
    afterSuccesses = 0,
  ): void {
    const key = this.midReadKey(path, name);
    const queued = this.appendFailures.get(key) ?? [];
    queued.push({ remainingSuccesses: afterSuccesses, error });
    this.appendFailures.set(key, queued);
  }

  /**
   * Forces the next {@link PiNativeSessionDirectory.deleteFile} for
   * `path`/`name` to fail with the given error.
   */
  simulateDeleteFailure(
    path: string,
    name: string,
    error: PiNativeSessionFsError,
  ): void {
    this.deleteFailures.set(this.midReadKey(path, name), error);
  }

  private takeAppendFailure(
    path: string,
    name: string,
  ): PiNativeSessionFsError | undefined {
    const key = this.midReadKey(path, name);
    const queued = this.appendFailures.get(key);
    if (queued === undefined || queued.length === 0) return undefined;
    const next = queued[0];
    if (next === undefined) return undefined;
    if (next.remainingSuccesses > 0) {
      next.remainingSuccesses -= 1;
      return undefined;
    }
    queued.shift();
    if (queued.length === 0) this.appendFailures.delete(key);
    return next.error;
  }

  private takeDeleteFailure(
    path: string,
    name: string,
  ): PiNativeSessionFsError | undefined {
    const key = this.midReadKey(path, name);
    const error = this.deleteFailures.get(key);
    if (error === undefined) return undefined;
    this.deleteFailures.delete(key);
    return error;
  }

  simulateDirectoryFile(path: string, name: string): void {
    const directory = this.directories.get(path);
    if (directory) {
      directory.files.set(name, {
        identity: nextMemoryIdentity(0o700),
        mode: 0o700,
        symlink: false,
        kind: "directory",
        bytes: new Uint8Array(),
        mtimeMs: nextMemoryMtime(),
      });
    }
  }

  files(path: string): ReadonlyMap<string, Uint8Array> {
    const files = this.directories.get(path)?.files;
    if (files === undefined) return new Map();
    return new Map(
      [...files.entries()]
        .filter(([, file]) => file.kind === "file" && !file.symlink)
        .map(([name, file]) => [name, new Uint8Array(file.bytes)]),
    );
  }
}

function validateMemoryFile(
  file: MemoryFileData,
): Result<MemoryFileData, PiNativeSessionFsError> {
  if (file.symlink) return err({ type: "symlink-rejected" });
  if (file.hardlink) return err({ type: "identity-changed" });
  if (file.kind !== "file") return err({ type: "wrong-kind", kind: "file" });
  if (file.mode !== 0o600)
    return err({ type: "permissive-mode", kind: "file" });
  return ok(file);
}

/** The production no-follow filesystem port for native child sessions. */
export function createBunPiNativeSessionFs(): PiNativeSessionFsPort {
  return new BunPiNativeSessionFs();
}
