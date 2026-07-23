/**
 * Engine-scoped rotating pino sink under `.weave/runtime/logs`.
 *
 * Spec 33 §19.2 / ADR 0011:
 * - Bun-only I/O with no-follow stable parent/file identity
 * - Hold a no-follow parent directory handle; open/rotate segments relative to it
 * - Reject symlink or swapped parent/target identity (fail closed)
 * - Never path-check-then-reopen for segment I/O
 * - Restrictive permissions; record-boundary serialized rotation/pruning
 * - Log failure must not recurse through the failed sink
 * - Injectable filesystem seams for isolated tests
 */

import { dlopen, type Pointer, ptr } from "bun:ffi";
import { join } from "node:path";
import type { RuntimeLogSettings } from "@weaveio/weave-core";
import { DEFAULT_RUNTIME_LOG_SETTINGS } from "@weaveio/weave-core";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type { DestinationStream } from "pino";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RuntimeLogSinkError =
  | {
      readonly type: "initialization";
      readonly message: string;
      readonly cause?: string;
    }
  | {
      readonly type: "identity";
      readonly message: string;
    }
  | {
      readonly type: "io";
      readonly message: string;
      readonly cause?: string;
    }
  | {
      readonly type: "rotation";
      readonly message: string;
      readonly cause?: string;
    };

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/** Stable file identity (dev/ino). size/mtime are observational only. */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * A held parent log-directory handle.
 *
 * Production opens this with O_NOFOLLOW|O_DIRECTORY and keeps the FD.
 * All segment opens, renames, unlinks, and listing happen relative to it.
 */
export interface RuntimeLogDirectoryHandle {
  readonly path: string;
  identity(): ResultAsync<FileIdentity, RuntimeLogSinkError>;
  openAppendRelative(
    fileName: string,
    mode: number,
  ): ResultAsync<RuntimeLogFileHandle, RuntimeLogSinkError>;
  renameRelative(
    fromName: string,
    toName: string,
    expectedSource?: FileIdentity,
  ): ResultAsync<void, RuntimeLogSinkError>;
  unlinkRelative(fileName: string): ResultAsync<void, RuntimeLogSinkError>;
  listRelative(): ResultAsync<readonly string[], RuntimeLogSinkError>;
  close(): ResultAsync<void, RuntimeLogSinkError>;
}

export interface RuntimeLogFileHandle {
  readonly fileName: string;
  identity(): ResultAsync<FileIdentity, RuntimeLogSinkError>;
  write(bytes: Uint8Array): ResultAsync<void, RuntimeLogSinkError>;
  close(): ResultAsync<void, RuntimeLogSinkError>;
}

/**
 * Filesystem port used by the rotating sink.
 *
 * `ensureLogDirectory` must return a held parent handle. Callers never open
 * segments by absolute path after that point.
 */
export interface RuntimeLogFileSystem {
  ensureLogDirectory(
    path: string,
    mode: number,
  ): ResultAsync<RuntimeLogDirectoryHandle, RuntimeLogSinkError>;
}

export interface RuntimeLogSinkOptions {
  /** Absolute project root. Logs go to `<projectRoot>/.weave/runtime/logs`. */
  readonly projectRoot: string;
  /**
   * Active segment file name inside the log directory
   * (e.g. `pi-adapter.ndjson` or `weave-engine.ndjson`).
   */
  readonly fileName: string;
  readonly settings?: RuntimeLogSettings;
  readonly fs?: RuntimeLogFileSystem;
  /** Directory mode (default 0o700). */
  readonly directoryMode?: number;
  /** File mode (default 0o600). */
  readonly fileMode?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_DIR_MODE = 0o700;
const DEFAULT_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Platform flags / FFI helpers (production Bun path)
// ---------------------------------------------------------------------------

interface LibcSymbols {
  readonly open: (
    path: Pointer | TypedArray | string | null,
    flags: number,
    mode?: number,
  ) => number;
  readonly openat: (
    dirfd: number,
    path: Pointer | TypedArray | string | null,
    flags: number,
    mode?: number,
  ) => number;
  readonly close: (fd: number) => number;
  readonly write: (
    fd: number,
    buf: Pointer | TypedArray | string | null,
    count: number,
  ) => number;
  readonly fchmod: (fd: number, mode: number) => number;
  readonly renameat: (
    olddirfd: number,
    oldpath: Pointer | TypedArray | string | null,
    newdirfd: number,
    newpath: Pointer | TypedArray | string | null,
  ) => number;
  readonly unlinkat: (
    dirfd: number,
    path: Pointer | TypedArray | string | null,
    flags: number,
  ) => number;
}

type TypedArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

interface PlatformFlags {
  readonly O_RDONLY: number;
  readonly O_RDWR: number;
  readonly O_CREAT: number;
  readonly O_APPEND: number;
  readonly O_DIRECTORY: number;
  readonly O_NOFOLLOW: number;
  readonly O_CLOEXEC: number;
}

function platformFlags(): PlatformFlags | undefined {
  if (process.platform === "darwin") {
    return {
      O_RDONLY: 0x0000,
      O_RDWR: 0x0002,
      O_CREAT: 0x0200,
      O_APPEND: 0x0008,
      O_DIRECTORY: 0x0010_0000,
      O_NOFOLLOW: 0x0100,
      O_CLOEXEC: 0x0100_0000,
    };
  }
  if (process.platform === "linux") {
    return {
      O_RDONLY: 0,
      O_RDWR: 0x2,
      O_CREAT: 0x40,
      O_APPEND: 0x400,
      O_DIRECTORY: 0x1_0000,
      O_NOFOLLOW: 0x2_0000,
      O_CLOEXEC: 0x8_0000,
    };
  }
  return undefined;
}

function libcPath(): string | undefined {
  if (process.platform === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (process.platform === "linux") return "libc.so.6";
  return undefined;
}

function cstr(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`);
}

/** Lift a synchronous `Result` into `ResultAsync` for use in async chains. */
function toResultAsync<T, E>(result: Result<T, E>): ResultAsync<T, E> {
  return result.match(
    (value) => okAsync(value),
    (error) => errAsync(error),
  );
}

function loadLibc(): Result<
  { library: ReturnType<typeof dlopen>; symbols: LibcSymbols },
  RuntimeLogSinkError
> {
  const libraryPath = libcPath();
  if (libraryPath === undefined) {
    return err({
      type: "initialization",
      message: "no-follow log I/O is unavailable on this platform",
    });
  }

  return Result.fromThrowable(
    () => {
      const library = dlopen(libraryPath, {
        open: {
          args: ["ptr", "i32", "i32"],
          returns: "i32",
        },
        openat: {
          args: ["i32", "ptr", "i32", "i32"],
          returns: "i32",
        },
        close: { args: ["i32"], returns: "i32" },
        write: { args: ["i32", "ptr", "u64"], returns: "i64" },
        fchmod: { args: ["i32", "i32"], returns: "i32" },
        renameat: {
          args: ["i32", "ptr", "i32", "ptr"],
          returns: "i32",
        },
        unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
      });
      return {
        library,
        symbols: library.symbols as unknown as LibcSymbols,
      };
    },
    (cause) =>
      ({
        type: "initialization",
        message: "failed to load libc for no-follow log I/O",
        cause: String(cause),
      }) as const,
  )();
}

/**
 * Read identity from an open FD via Bun.file(fd).stat().
 * Same descriptor — no path reopen.
 */
/**
 * Single fstat-equivalent read of an open descriptor's identity via
 * `Bun.file(fd).stat()`. Enforces the expected kind (file or directory) in
 * the same call so no second stat/reopen is needed.
 */
function identityFromFd(
  fd: number,
  expectedKind: "file" | "directory",
): ResultAsync<FileIdentity, RuntimeLogSinkError> {
  return ResultAsync.fromPromise(
    Bun.file(fd).stat(),
    (cause) =>
      ({
        type: "identity",
        message: "failed to fstat log descriptor",
        cause: String(cause),
      }) as const,
  ).andThen((stat) => {
    const matchesKind =
      expectedKind === "file" ? stat.isFile() : stat.isDirectory();
    if (!matchesKind) {
      return errAsync({
        type: "identity" as const,
        message:
          expectedKind === "file"
            ? "log segment is not a regular file"
            : "log directory is not a directory",
      });
    }
    return okAsync({
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  });
}

function ensureDirectoryTree(
  path: string,
  mode: number,
): ResultAsync<void, RuntimeLogSinkError> {
  const modeOctal = (mode & 0o777).toString(8).padStart(3, "0");
  return ResultAsync.fromPromise(
    (async () => {
      const proc = Bun.spawn(["mkdir", "-p", "-m", modeOctal, path], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(stderr || "mkdir failed");
      }
    })(),
    (cause) =>
      ({
        type: "initialization",
        message: "failed to create log directory",
        cause: String(cause),
      }) as const,
  );
}

// ---------------------------------------------------------------------------
// Production Bun no-follow filesystem
// ---------------------------------------------------------------------------

class BunNoFollowFileHandle implements RuntimeLogFileHandle {
  constructor(
    readonly fileName: string,
    private fd: number,
    private readonly symbols: LibcSymbols,
  ) {}

  identity(): ResultAsync<FileIdentity, RuntimeLogSinkError> {
    if (this.fd < 0) {
      return errAsync({
        type: "identity",
        message: "log file handle is closed",
      });
    }
    return identityFromFd(this.fd, "file");
  }

  write(bytes: Uint8Array): ResultAsync<void, RuntimeLogSinkError> {
    if (this.fd < 0) {
      return errAsync({ type: "io", message: "log file handle is closed" });
    }
    return toResultAsync(
      Result.fromThrowable(
        () => {
          let offset = 0;
          while (offset < bytes.length) {
            const slice = bytes.subarray(offset);
            const written = Number(
              this.symbols.write(this.fd, ptr(slice), slice.byteLength),
            );
            if (written < 0) {
              throw new Error("write failed");
            }
            offset += written;
          }
        },
        (cause) =>
          ({
            type: "io",
            message: "failed to write log segment",
            cause: String(cause),
          }) as const,
      )(),
    );
  }

  close(): ResultAsync<void, RuntimeLogSinkError> {
    if (this.fd < 0) return okAsync(undefined);
    const fd = this.fd;
    this.fd = -1;
    return toResultAsync(
      Result.fromThrowable(
        () => {
          this.symbols.close(fd);
        },
        (cause) =>
          ({
            type: "io",
            message: "failed to close log segment",
            cause: String(cause),
          }) as const,
      )(),
    );
  }
}

class BunNoFollowDirectoryHandle implements RuntimeLogDirectoryHandle {
  private closed = false;

  constructor(
    readonly path: string,
    private dirFd: number,
    private readonly boundIdentity: FileIdentity,
    private readonly symbols: LibcSymbols,
    private readonly flags: PlatformFlags,
    private readonly library: ReturnType<typeof dlopen>,
  ) {}

  identity(): ResultAsync<FileIdentity, RuntimeLogSinkError> {
    if (this.closed || this.dirFd < 0) {
      return errAsync({
        type: "identity",
        message: "log directory handle is closed",
      });
    }
    return identityFromFd(this.dirFd, "directory").andThen((current) => {
      if (!identitiesMatch(current, this.boundIdentity)) {
        return errAsync({
          type: "identity" as const,
          message: "log directory identity changed; refusing operation",
        });
      }
      return okAsync(current);
    });
  }

  openAppendRelative(
    fileName: string,
    mode: number,
  ): ResultAsync<RuntimeLogFileHandle, RuntimeLogSinkError> {
    return this.identity().andThen(() =>
      toResultAsync(
        Result.fromThrowable(
          () => {
            const openFlags =
              this.flags.O_RDWR |
              this.flags.O_CREAT |
              this.flags.O_APPEND |
              this.flags.O_NOFOLLOW |
              this.flags.O_CLOEXEC;
            const fd = this.symbols.openat(
              this.dirFd,
              ptr(cstr(fileName)),
              openFlags,
              mode & 0o777,
            );
            if (fd < 0) {
              throw new Error(
                "openat failed (symlink, missing parent, or permission denied)",
              );
            }
            const chmodRc = this.symbols.fchmod(fd, mode & 0o777);
            if (chmodRc !== 0) {
              this.symbols.close(fd);
              throw new Error("fchmod failed");
            }
            return new BunNoFollowFileHandle(fileName, fd, this.symbols);
          },
          (cause) =>
            ({
              type: "io",
              message: "failed to open log segment relative to parent handle",
              cause: String(cause),
            }) as const,
        )(),
      ).andThen((handle) =>
        // Fail closed if the opened target is not a regular file (e.g. raced).
        handle.identity().map(() => handle),
      ),
    );
  }

  renameRelative(
    fromName: string,
    toName: string,
    expectedSource?: FileIdentity,
  ): ResultAsync<void, RuntimeLogSinkError> {
    return this.identity()
      .andThen(() => {
        if (expectedSource === undefined) return okAsync(undefined);
        return this.verifySourceIdentityViaParent(fromName, expectedSource);
      })
      .andThen(() =>
        Result.fromThrowable(
          () => {
            const rc = this.symbols.renameat(
              this.dirFd,
              ptr(cstr(fromName)),
              this.dirFd,
              ptr(cstr(toName)),
            );
            if (rc !== 0) {
              throw new Error("renameat failed");
            }
          },
          (cause) =>
            ({
              type: "rotation",
              message: "failed to rename log segment via parent handle",
              cause: String(cause),
            }) as const,
        )(),
      );
  }

  /**
   * Verify the rotation source's identity via `openat` on the held parent
   * handle — never a path check followed by an unrelated reopen. `finally`
   * guarantees the verification descriptor closes exactly once regardless of
   * outcome; the caught boundary converts immediately to a typed `Result`.
   */
  private verifySourceIdentityViaParent(
    fromName: string,
    expectedSource: FileIdentity,
  ): ResultAsync<void, RuntimeLogSinkError> {
    return ResultAsync.fromPromise(
      (async (): Promise<Result<void, RuntimeLogSinkError>> => {
        let fd = -1;
        try {
          fd = this.symbols.openat(
            this.dirFd,
            ptr(cstr(fromName)),
            this.flags.O_RDONLY | this.flags.O_NOFOLLOW | this.flags.O_CLOEXEC,
            0,
          );
          if (fd < 0) {
            return err({
              type: "rotation",
              message: "failed to open rotation source via parent handle",
            });
          }
          const current = await identityFromFd(fd, "file").match(
            (identity) => ok(identity),
            (error) => err(error),
          );
          if (current.isErr()) return current;
          if (!identitiesMatch(current.value, expectedSource)) {
            return err({
              type: "identity",
              message: "rotation source identity changed; refusing rename",
            });
          }
          return ok(undefined);
        } finally {
          if (fd >= 0) this.symbols.close(fd);
        }
      })(),
      (cause) =>
        ({
          type: "rotation",
          message: "unexpected failure verifying rotation source identity",
          cause: String(cause),
        }) as const,
    ).andThen((result) => result);
  }

  unlinkRelative(fileName: string): ResultAsync<void, RuntimeLogSinkError> {
    return this.identity().andThen(() =>
      Result.fromThrowable(
        () => {
          const rc = this.symbols.unlinkat(this.dirFd, ptr(cstr(fileName)), 0);
          if (rc !== 0) {
            throw new Error("unlinkat failed");
          }
        },
        (cause) =>
          ({
            type: "io",
            message: "failed to unlink log segment via parent handle",
            cause: String(cause),
          }) as const,
      )(),
    );
  }

  listRelative(): ResultAsync<readonly string[], RuntimeLogSinkError> {
    // Revalidate held parent identity first. Listing uses the verified path
    // only to discover names; all mutations remain relative to dirFd.
    return this.identity().andThen(() =>
      ResultAsync.fromPromise(
        (async () => {
          const glob = new Bun.Glob("*");
          const names: string[] = [];
          for await (const name of glob.scan({
            cwd: this.path,
            onlyFiles: true,
          })) {
            names.push(name);
          }
          return names;
        })(),
        (cause) =>
          ({
            type: "io",
            message: "failed to list log directory",
            cause: String(cause),
          }) as const,
      ),
    );
  }

  close(): ResultAsync<void, RuntimeLogSinkError> {
    if (this.closed) return okAsync(undefined);
    this.closed = true;
    const fd = this.dirFd;
    this.dirFd = -1;
    return toResultAsync(
      Result.fromThrowable(
        () => {
          this.symbols.close(fd);
          this.library.close();
        },
        (cause) =>
          ({
            type: "io",
            message: "failed to close log directory handle",
            cause: String(cause),
          }) as const,
      )(),
    );
  }
}

/**
 * Production filesystem: Bun-only, no Node `fs`/`child_process`.
 *
 * Creates the directory tree, then opens and holds an O_NOFOLLOW|O_DIRECTORY
 * parent FD. Segment opens use openat; rotation uses renameat after identity
 * checks on the held handles. Symlinks fail closed.
 */
export class BunRuntimeLogFileSystem implements RuntimeLogFileSystem {
  ensureLogDirectory(
    path: string,
    mode: number,
  ): ResultAsync<RuntimeLogDirectoryHandle, RuntimeLogSinkError> {
    const flags = platformFlags();
    if (flags === undefined) {
      return errAsync({
        type: "initialization",
        message: "no-follow log I/O is unavailable on this platform",
      });
    }

    const loaded = loadLibc();
    if (loaded.isErr()) return errAsync(loaded.error);
    const { library, symbols } = loaded.value;

    return ensureDirectoryTree(path, mode).andThen(() =>
      toResultAsync(
        Result.fromThrowable(
          () => {
            const dirFlags =
              flags.O_RDONLY |
              flags.O_DIRECTORY |
              flags.O_NOFOLLOW |
              flags.O_CLOEXEC;
            const dirFd = symbols.open(ptr(cstr(path)), dirFlags, 0);
            if (dirFd < 0) {
              library.close();
              throw new Error(
                "failed to open log directory with O_NOFOLLOW|O_DIRECTORY",
              );
            }
            const chmodRc = symbols.fchmod(dirFd, mode & 0o777);
            if (chmodRc !== 0) {
              symbols.close(dirFd);
              library.close();
              throw new Error("failed to fchmod log directory");
            }
            return dirFd;
          },
          (cause) => {
            try {
              library.close();
            } catch {
              // ignore close errors while mapping open failure
            }
            return {
              type: "initialization" as const,
              message:
                "failed to acquire no-follow log directory handle (symlink or access denied)",
              cause: String(cause),
            };
          },
        )(),
      ).andThen((dirFd) =>
        identityFromFd(dirFd, "directory")
          .map((identity) => {
            return new BunNoFollowDirectoryHandle(
              path,
              dirFd,
              identity,
              symbols,
              flags,
              library,
            );
          })
          .mapErr((error) => {
            symbols.close(dirFd);
            library.close();
            return error;
          }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory filesystem for tests (models parent-handle semantics explicitly)
// ---------------------------------------------------------------------------

class MemoryLogFileHandle implements RuntimeLogFileHandle {
  constructor(
    readonly fileName: string,
    private readonly dir: MemoryLogDirectoryHandle,
  ) {}

  identity(): ResultAsync<FileIdentity, RuntimeLogSinkError> {
    return this.dir.statFile(this.fileName);
  }

  write(bytes: Uint8Array): ResultAsync<void, RuntimeLogSinkError> {
    return this.dir.appendFile(this.fileName, bytes);
  }

  close(): ResultAsync<void, RuntimeLogSinkError> {
    return okAsync(undefined);
  }
}

class MemoryLogDirectoryHandle implements RuntimeLogDirectoryHandle {
  private closed = false;

  constructor(
    readonly path: string,
    private readonly boundIdentity: FileIdentity,
    private readonly fs: MemoryRuntimeLogFileSystem,
  ) {}

  identity(): ResultAsync<FileIdentity, RuntimeLogSinkError> {
    if (this.closed) {
      return errAsync({
        type: "identity",
        message: "log directory handle is closed",
      });
    }
    return this.fs.statDir(this.path).andThen((current) => {
      if (!identitiesMatch(current, this.boundIdentity)) {
        return errAsync({
          type: "identity" as const,
          message: "log directory identity changed; refusing operation",
        });
      }
      return okAsync(current);
    });
  }

  openAppendRelative(
    fileName: string,
    _mode: number,
  ): ResultAsync<RuntimeLogFileHandle, RuntimeLogSinkError> {
    return this.identity().andThen(() =>
      this.fs
        .ensureFile(this.path, fileName)
        .map(() => new MemoryLogFileHandle(fileName, this)),
    );
  }

  renameRelative(
    fromName: string,
    toName: string,
    expectedSource?: FileIdentity,
  ): ResultAsync<void, RuntimeLogSinkError> {
    return this.identity().andThen(() =>
      this.fs.renameFile(this.path, fromName, toName, expectedSource),
    );
  }

  unlinkRelative(fileName: string): ResultAsync<void, RuntimeLogSinkError> {
    return this.identity().andThen(() =>
      this.fs.unlinkFile(this.path, fileName),
    );
  }

  listRelative(): ResultAsync<readonly string[], RuntimeLogSinkError> {
    return this.identity().andThen(() => this.fs.listFiles(this.path));
  }

  close(): ResultAsync<void, RuntimeLogSinkError> {
    this.closed = true;
    return okAsync(undefined);
  }

  statFile(fileName: string): ResultAsync<FileIdentity, RuntimeLogSinkError> {
    return this.fs.statFile(this.path, fileName);
  }

  appendFile(
    fileName: string,
    bytes: Uint8Array,
  ): ResultAsync<void, RuntimeLogSinkError> {
    return this.fs.appendFile(this.path, fileName, bytes);
  }
}

/** Deterministic in-memory filesystem modeling held parent-handle semantics. */
export class MemoryRuntimeLogFileSystem implements RuntimeLogFileSystem {
  private readonly files = new Map<
    string,
    { bytes: Uint8Array; identity: FileIdentity }
  >();
  private readonly dirs = new Map<string, FileIdentity>();
  private inodeCounter = 1;
  /** When set, next ensureLogDirectory fails (symlink simulation). */
  private rejectNextDirectory = false;

  /** Test seam: next directory open fails closed as if the path were a symlink. */
  simulateSymlinkDirectory(): void {
    this.rejectNextDirectory = true;
  }

  /** Test seam: swap directory identity under a held handle. */
  swapDirectoryIdentity(path: string): void {
    const current = this.dirs.get(path);
    if (!current) return;
    this.dirs.set(path, {
      ...current,
      ino: this.inodeCounter++,
      mtimeMs: Date.now(),
    });
  }

  /** Test seam: swap a file identity under a held handle. */
  swapFileIdentity(dirPath: string, fileName: string): void {
    const key = this.fileKey(dirPath, fileName);
    const file = this.files.get(key);
    if (!file) return;
    file.identity = {
      ...file.identity,
      ino: this.inodeCounter++,
      mtimeMs: Date.now(),
    };
  }

  ensureLogDirectory(
    path: string,
    _mode: number,
  ): ResultAsync<RuntimeLogDirectoryHandle, RuntimeLogSinkError> {
    if (this.rejectNextDirectory) {
      this.rejectNextDirectory = false;
      return errAsync({
        type: "initialization",
        message:
          "failed to acquire no-follow log directory handle (symlink or access denied)",
      });
    }
    let identity = this.dirs.get(path);
    if (!identity) {
      identity = {
        dev: 1,
        ino: this.inodeCounter++,
        size: 0,
        mtimeMs: Date.now(),
      };
      this.dirs.set(path, identity);
    }
    return okAsync(new MemoryLogDirectoryHandle(path, identity, this));
  }

  statDir(path: string): ResultAsync<FileIdentity, RuntimeLogSinkError> {
    const identity = this.dirs.get(path);
    if (!identity) {
      return errAsync({
        type: "identity",
        message: `missing directory identity: ${path}`,
      });
    }
    return okAsync(identity);
  }

  ensureFile(
    dirPath: string,
    fileName: string,
  ): ResultAsync<void, RuntimeLogSinkError> {
    const key = this.fileKey(dirPath, fileName);
    if (!this.files.has(key)) {
      this.files.set(key, {
        bytes: new Uint8Array(),
        identity: {
          dev: 1,
          ino: this.inodeCounter++,
          size: 0,
          mtimeMs: Date.now(),
        },
      });
    }
    return okAsync(undefined);
  }

  statFile(
    dirPath: string,
    fileName: string,
  ): ResultAsync<FileIdentity, RuntimeLogSinkError> {
    const file = this.files.get(this.fileKey(dirPath, fileName));
    if (!file) {
      return errAsync({
        type: "identity",
        message: `missing file identity: ${fileName}`,
      });
    }
    return okAsync(file.identity);
  }

  appendFile(
    dirPath: string,
    fileName: string,
    bytes: Uint8Array,
  ): ResultAsync<void, RuntimeLogSinkError> {
    const key = this.fileKey(dirPath, fileName);
    const file = this.files.get(key);
    if (!file) {
      return errAsync({ type: "io", message: `missing file: ${fileName}` });
    }
    const merged = new Uint8Array(file.bytes.length + bytes.length);
    merged.set(file.bytes, 0);
    merged.set(bytes, file.bytes.length);
    file.bytes = merged;
    // Append keeps inode stable (models true O_APPEND handle semantics).
    file.identity = {
      ...file.identity,
      size: merged.length,
      mtimeMs: Date.now(),
    };
    return okAsync(undefined);
  }

  renameFile(
    dirPath: string,
    fromName: string,
    toName: string,
    expectedSource?: FileIdentity,
  ): ResultAsync<void, RuntimeLogSinkError> {
    const fromKey = this.fileKey(dirPath, fromName);
    const file = this.files.get(fromKey);
    if (!file) {
      return errAsync({
        type: "rotation",
        message: `source segment missing: ${fromName}`,
      });
    }
    if (
      expectedSource !== undefined &&
      !identitiesMatch(file.identity, expectedSource)
    ) {
      return errAsync({
        type: "identity",
        message: "rotation source identity changed; refusing rename",
      });
    }
    this.files.set(this.fileKey(dirPath, toName), {
      bytes: file.bytes,
      identity: {
        ...file.identity,
        ino: this.inodeCounter++,
        mtimeMs: Date.now(),
      },
    });
    this.files.delete(fromKey);
    return okAsync(undefined);
  }

  unlinkFile(
    dirPath: string,
    fileName: string,
  ): ResultAsync<void, RuntimeLogSinkError> {
    this.files.delete(this.fileKey(dirPath, fileName));
    return okAsync(undefined);
  }

  listFiles(
    dirPath: string,
  ): ResultAsync<readonly string[], RuntimeLogSinkError> {
    const prefix = `${dirPath}/`;
    const names: string[] = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        names.push(key.slice(prefix.length));
      }
    }
    return okAsync(names);
  }

  /** Test helper: absolute path text for the active segment. */
  readText(absolutePath: string): string | undefined {
    const file = this.files.get(absolutePath);
    if (!file) return undefined;
    return new TextDecoder().decode(file.bytes);
  }

  /** Test helper: list stored absolute file paths. */
  paths(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  private fileKey(dirPath: string, fileName: string): string {
    return `${dirPath}/${fileName}`;
  }
}

// ---------------------------------------------------------------------------
// Rotating sink
// ---------------------------------------------------------------------------

/**
 * Serialized rotating NDJSON sink suitable as a pino destination.
 *
 * Holds a parent directory handle and binds every segment open/rotation to
 * that stable identity. Failures are recorded and never logged back through
 * this sink (no recursion).
 */
export class RotatingRuntimeLogSink implements DestinationStream {
  readonly logDirectory: string;
  readonly activePath: string;

  private readonly fs: RuntimeLogFileSystem;
  private readonly settings: RuntimeLogSettings;
  private readonly fileMode: number;
  private readonly directoryMode: number;
  private readonly fileName: string;

  private parent: RuntimeLogDirectoryHandle | null = null;
  private handle: RuntimeLogFileHandle | null = null;
  private parentIdentity: FileIdentity | null = null;
  private fileIdentity: FileIdentity | null = null;
  private chain: Promise<void> = Promise.resolve();
  private initialized = false;
  private failed = false;
  private lastError: RuntimeLogSinkError | null = null;
  private bytesInSegment = 0;

  constructor(options: RuntimeLogSinkOptions) {
    this.logDirectory = join(options.projectRoot, ".weave", "runtime", "logs");
    this.fileName = options.fileName;
    this.activePath = join(this.logDirectory, options.fileName);
    this.settings = options.settings ?? { ...DEFAULT_RUNTIME_LOG_SETTINGS };
    this.fs = options.fs ?? new BunRuntimeLogFileSystem();
    this.fileMode = options.fileMode ?? DEFAULT_FILE_MODE;
    this.directoryMode = options.directoryMode ?? DEFAULT_DIR_MODE;
  }

  /** Last sink failure, if any. Never written back through this sink. */
  getLastError(): RuntimeLogSinkError | null {
    return this.lastError;
  }

  /** True after a non-recoverable sink failure until re-initialized. */
  hasFailed(): boolean {
    return this.failed;
  }

  /**
   * Acquire the no-follow parent handle, open the active segment relative to
   * it, and bind parent/file identities. Production never synthesizes identity.
   */
  initialize(): ResultAsync<void, RuntimeLogSinkError> {
    return this.fs
      .ensureLogDirectory(this.logDirectory, this.directoryMode)
      .andThen((parent) => {
        this.parent = parent;
        return parent.identity();
      })
      .andThen((parentIdentity) => {
        this.parentIdentity = parentIdentity;
        if (!this.parent) {
          return errAsync({
            type: "initialization" as const,
            message: "parent handle missing after open",
          });
        }
        return this.parent.openAppendRelative(this.fileName, this.fileMode);
      })
      .andThen((handle) => {
        this.handle = handle;
        return handle.identity();
      })
      .andThen((identity) => {
        this.fileIdentity = identity;
        this.bytesInSegment = identity.size;
        this.initialized = true;
        this.failed = false;
        this.lastError = null;
        return okAsync(undefined);
      })
      .mapErr((error) => {
        this.recordFailure(error);
        return error;
      });
  }

  /**
   * pino DestinationStream.write — enqueues one record and returns immediately.
   * Failures are swallowed after recording so pino does not recurse.
   */
  write(chunk: string | Uint8Array): void {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;

    this.chain = this.chain
      .then(async () => {
        if (this.failed) return;
        if (!this.initialized) {
          const init = await this.initialize();
          if (init.isErr()) return;
        }
        const result = await this.writeRecord(bytes);
        if (result.isErr()) this.recordFailure(result.error);
      })
      .catch(() => {
        this.recordFailure({
          type: "io",
          message: "unexpected log sink write chain failure",
        });
      });
  }

  /** Flush the serialized write chain (tests / orderly shutdown). */
  flush(): ResultAsync<void, RuntimeLogSinkError> {
    return ResultAsync.fromPromise(
      this.chain,
      (cause) =>
        ({
          type: "io",
          message: "failed to flush log sink",
          cause: String(cause),
        }) as const,
    );
  }

  private writeRecord(
    bytes: Uint8Array,
  ): ResultAsync<void, RuntimeLogSinkError> {
    if (!this.handle || !this.fileIdentity || !this.parent) {
      return errAsync({
        type: "initialization",
        message: "log sink is not initialized",
      });
    }

    return this.revalidateIdentities()
      .andThen(() => {
        if (
          this.bytesInSegment > 0 &&
          this.bytesInSegment + bytes.length > this.settings.max_segment_bytes
        ) {
          return this.rotateAndPrune();
        }
        return okAsync(undefined);
      })
      .andThen(() => {
        const handle = this.handle;
        if (!handle) {
          return errAsync({
            type: "initialization" as const,
            message: "log handle missing after rotation",
          });
        }
        return handle.write(bytes);
      })
      .andThen(() => {
        this.bytesInSegment += bytes.length;
        const handle = this.handle;
        if (!handle) return okAsync(undefined);
        return handle.identity().map((identity) => {
          this.fileIdentity = identity;
          return undefined;
        });
      });
  }

  private revalidateIdentities(): ResultAsync<void, RuntimeLogSinkError> {
    const parent = this.parent;
    const handle = this.handle;
    const boundParent = this.parentIdentity;
    const boundFile = this.fileIdentity;
    if (!parent || !handle || !boundParent || !boundFile) {
      return errAsync({
        type: "identity",
        message: "missing bound log identities",
      });
    }

    return parent.identity().andThen((parentCurrent) => {
      if (!identitiesMatch(parentCurrent, boundParent)) {
        return errAsync({
          type: "identity" as const,
          message: "log directory identity changed; refusing write",
        });
      }
      this.parentIdentity = parentCurrent;
      return handle.identity().andThen((fileCurrent) => {
        if (!identitiesMatch(fileCurrent, boundFile)) {
          return errAsync({
            type: "identity" as const,
            message: "log file identity changed; refusing write",
          });
        }
        this.fileIdentity = fileCurrent;
        this.bytesInSegment = fileCurrent.size;
        return okAsync(undefined);
      });
    });
  }

  private rotateAndPrune(): ResultAsync<void, RuntimeLogSinkError> {
    const parent = this.parent;
    const handle = this.handle;
    const expectedSource = this.fileIdentity;
    if (!parent || !handle || !expectedSource) {
      return errAsync({
        type: "rotation",
        message: "no active handle to rotate",
      });
    }

    const stamp = Date.now();
    const rotatedName = `${this.fileName}.${stamp}`;

    return this.revalidateIdentities()
      .andThen(() => handle.close())
      .andThen(() =>
        parent.renameRelative(this.fileName, rotatedName, expectedSource),
      )
      .andThen(() => parent.openAppendRelative(this.fileName, this.fileMode))
      .andThen((newHandle) => {
        this.handle = newHandle;
        this.bytesInSegment = 0;
        return newHandle.identity();
      })
      .andThen((identity) => {
        this.fileIdentity = identity;
        return this.pruneSegments();
      });
  }

  private pruneSegments(): ResultAsync<void, RuntimeLogSinkError> {
    const parent = this.parent;
    if (!parent) {
      return errAsync({
        type: "rotation",
        message: "parent handle missing during prune",
      });
    }

    return parent.listRelative().andThen((names) => {
      const rotated = names
        .filter(
          (name) =>
            name.startsWith(`${this.fileName}.`) && name !== this.fileName,
        )
        .sort();

      // max_segments includes the active segment.
      const maxRotated = Math.max(0, this.settings.max_segments - 1);
      if (rotated.length <= maxRotated) return okAsync(undefined);

      const toRemove = rotated.slice(0, rotated.length - maxRotated);
      let chain: ResultAsync<void, RuntimeLogSinkError> = okAsync(undefined);
      for (const name of toRemove) {
        chain = chain.andThen(() => parent.unlinkRelative(name));
      }
      return chain;
    });
  }

  private recordFailure(error: RuntimeLogSinkError): void {
    this.failed = true;
    this.lastError = error;
    // Intentionally do not log through this sink — avoids recursion.
  }
}

/**
 * Create and initialize a rotating runtime log sink.
 */
export function createRotatingRuntimeLogSink(
  options: RuntimeLogSinkOptions,
): ResultAsync<RotatingRuntimeLogSink, RuntimeLogSinkError> {
  const sink = new RotatingRuntimeLogSink(options);
  return sink.initialize().map(() => sink);
}

/**
 * Bind a pino-compatible destination that never throws on write failure.
 */
export function asPinoDestination(
  sink: RotatingRuntimeLogSink,
): DestinationStream {
  return sink;
}

/** Pure helper exported for tests: decide whether a write would rotate. */
export function wouldRotate(
  bytesInSegment: number,
  incomingBytes: number,
  maxSegmentBytes: number,
): boolean {
  if (bytesInSegment <= 0) return false;
  return bytesInSegment + incomingBytes > maxSegmentBytes;
}

/** Match stable parent/file identity by dev/ino only. */
export function identitiesMatch(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export function validateLogSettings(
  settings: RuntimeLogSettings,
): Result<RuntimeLogSettings, RuntimeLogSinkError> {
  if (
    !Number.isInteger(settings.max_segment_bytes) ||
    settings.max_segment_bytes < 65_536 ||
    settings.max_segment_bytes > 1_073_741_824
  ) {
    return err({
      type: "initialization",
      message: "max_segment_bytes out of range",
    });
  }
  if (
    !Number.isInteger(settings.max_segments) ||
    settings.max_segments < 1 ||
    settings.max_segments > 100
  ) {
    return err({
      type: "initialization",
      message: "max_segments out of range",
    });
  }
  return ok(settings);
}
