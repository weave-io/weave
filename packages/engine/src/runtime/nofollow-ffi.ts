/**
 * Shared, low-level Bun `bun:ffi` primitives for no-follow filesystem access.
 *
 * Extracted from `./log-sink.ts` (Pi adapter contract and ADR 0011) so that other
 * Weave-owned runtime I/O with the same no-follow stable-identity
 * requirement — notably the Runtime Store's SQLite open path (Pi adapter contract)
 * — can reuse the exact same platform flags, libc symbol loading, and
 * fd-identity helpers instead of re-declaring them.
 *
 * This module is intentionally generic: it has no opinion on directories
 * vs. log segments vs. database files, and its error type carries only a
 * message/cause pair. Callers map `NoFollowFfiError` onto their own typed
 * error unions (e.g. `RuntimeLogSinkError`, `RuntimeStoreError`).
 *
 * Platform detection uses `node:os`'s `platform()` (a Bun-native
 * compatibility module, per AGENTS.md) rather than the bare `process.platform`
 * global. Both `darwin` and `linux` are supported; every other platform is
 * treated as "no-follow I/O unavailable" and fails closed.
 *
 * Failure messages never interpolate a raw, unsanitized `cause` value (e.g.
 * `String(caughtException)`) since FFI/native failures can carry internal
 * pointers, buffers, or otherwise-unsanitized text. `sanitizeCause` extracts
 * only an `Error`'s `.message` (or a plain string), and otherwise substitutes
 * a fixed, non-leaking description.
 *
 * Not part of the package's public surface — no barrel re-export.
 */

import { dlopen, type Pointer, read } from "bun:ffi";
import { platform } from "node:os";
import { err, errAsync, okAsync, Result, ResultAsync } from "neverthrow";

/** Generic low-level FFI failure. Callers map this onto their own error type. */
export interface NoFollowFfiError {
  readonly message: string;
  readonly cause?: string;
}

export interface LibcSymbols {
  readonly open: (
    path: Pointer | TypedArray | null,
    flags: number,
    mode: number,
  ) => number;
  readonly openat: (
    dirfd: number,
    path: Pointer | TypedArray | null,
    flags: number,
    mode: number,
  ) => number;
  readonly mkdirat: (
    dirfd: number,
    path: Pointer | TypedArray | null,
    mode: number,
  ) => number;
  readonly close: (fd: number) => number;
  readonly write: (
    fd: number,
    buf: Pointer | TypedArray | null,
    count: number,
  ) => number;
  readonly fchmod: (fd: number, mode: number) => number;
  readonly umask: (mask: number) => number;
  readonly renameat: (
    olddirfd: number,
    oldpath: Pointer | TypedArray | null,
    newdirfd: number,
    newpath: Pointer | TypedArray | null,
  ) => number;
  readonly unlinkat: (
    dirfd: number,
    path: Pointer | TypedArray | null,
    flags: number,
  ) => number;
  readonly fsync: (fd: number) => number;
  /**
   * BSD/POSIX advisory whole-file lock. Identical operation constants
   * (`LOCK_SH`/`LOCK_EX`/`LOCK_NB`/`LOCK_UN`, see below) on both Darwin and
   * Linux, so no platform branching is needed the way `PlatformFlags` needs
   * for `open`/`openat` flags. Always called with `LOCK_NB` so a contended
   * lock returns immediately (`EWOULDBLOCK`) instead of blocking the
   * single-threaded event loop; callers retry with an async backoff.
   */
  readonly flock: (fd: number, operation: number) => number;
}

/**
 * `flock(2)` operation constants. These bit values are part of the BSD
 * `<sys/file.h>` ABI and are numerically identical on Darwin and Linux
 * (unlike `open()`'s `O_*` flags), so — unlike `PlatformFlags` — no
 * per-platform table is required.
 */
export const LOCK_SH = 1;
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

export type TypedArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

export interface PlatformFlags {
  readonly O_RDONLY: number;
  readonly O_RDWR: number;
  readonly O_CREAT: number;
  readonly O_EXCL: number;
  readonly O_TRUNC: number;
  readonly O_APPEND: number;
  readonly O_DIRECTORY: number;
  readonly O_NOFOLLOW: number;
  readonly O_CLOEXEC: number;
  /** Sentinel passed as `dirfd` to `*at()` calls to mean "resolve relative to CWD", i.e. treat `path` as if given to the non-`at` syscall. Value is platform-specific. */
  readonly AT_FDCWD: number;
}

/** Stable file identity (dev/ino). size/mtime are observational only. */
export interface FdIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

/** POSIX `ENOENT` — portable across Darwin and Linux. */
export const ERRNO_ENOENT = 2;
/** POSIX `EEXIST` — portable across Darwin and Linux. */
export const ERRNO_EEXIST = 17;

export function platformFlags(): PlatformFlags | undefined {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    return {
      O_RDONLY: 0x0000,
      O_RDWR: 0x0002,
      O_CREAT: 0x0200,
      O_EXCL: 0x0800,
      O_TRUNC: 0x0400,
      O_APPEND: 0x0008,
      O_DIRECTORY: 0x0010_0000,
      O_NOFOLLOW: 0x0100,
      O_CLOEXEC: 0x0100_0000,
      AT_FDCWD: -2,
    };
  }
  if (currentPlatform === "linux") {
    return {
      O_RDONLY: 0,
      O_RDWR: 0x2,
      O_CREAT: 0x40,
      O_EXCL: 0x80,
      O_TRUNC: 0x200,
      O_APPEND: 0x400,
      O_DIRECTORY: 0x1_0000,
      O_NOFOLLOW: 0x2_0000,
      O_CLOEXEC: 0x8_0000,
      AT_FDCWD: -100,
    };
  }
  return undefined;
}

export function libcPath(): string | undefined {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (currentPlatform === "linux") return "libc.so.6";
  return undefined;
}

type ErrnoSymbolName = "__error" | "__errno_location";

/** Errno accessor's exported C symbol name. libc only exposes `errno` via a function on both platforms. */
function errnoAccessorName(): ErrnoSymbolName | undefined {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") return "__error";
  if (currentPlatform === "linux") return "__errno_location";
  return undefined;
}

export function cstr(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`);
}

/** Lift a synchronous `Result` into `ResultAsync` for use in async chains. */
export function toResultAsync<T, E>(result: Result<T, E>): ResultAsync<T, E> {
  return result.match(
    (value) => okAsync(value),
    (error) => errAsync(error),
  );
}

/**
 * Extracts a safe-to-log description from a caught native/FFI failure.
 * Never interpolates the raw caught value: FFI throwables can carry
 * pointers, buffers, or other internal state that must not leak into logs
 * or typed error messages.
 */
export function sanitizeCause<T>(cause: T): string {
  if (cause instanceof Error) return cause.message;
  if (Object(cause) === cause) return "no-follow filesystem native call failed";
  const tag = Result.fromThrowable(
    () => Object.prototype.toString.call(cause),
    () => "[object Other]",
  )();
  if (tag.isOk() && tag.value === "[object String]") {
    const text = Result.fromThrowable(
      () => String(cause),
      () => "no-follow filesystem native call failed",
    )();
    if (text.isOk()) return text.value;
  }
  return "no-follow filesystem native call failed";
}

/**
 * `open`/`openat` are declared in POSIX as variadic (`int open(const char *,
 * int, ...)`); the trailing `mode` argument only exists when `O_CREAT` is
 * set. Empirically, on this platform's C ABI a variadic trailing argument
 * is passed differently than a fixed one (notably: Apple Silicon's calling
 * convention places variadic arguments on the stack, never in a register),
 * and `bun:ffi`'s symbol declaration has no way to mark a single trailing
 * argument as variadic — it always passes `mode` as if the call were fixed
 * arity. The result is that the `mode` value `open`/`openat` actually see is
 * unreliable: measured directly, the same call created files with mode bits
 * like `0o340` or `0o200` instead of the requested `0o600`, occasionally
 * narrow enough to omit the owner's own read permission and make an
 * immediately-following read-only reopen fail with `EACCES`.
 *
 * Every `O_CREAT`-bearing `open`/`openat` call MUST therefore run inside
 * this helper: it widens the process umask to `0o777` immediately before
 * creating (so whatever garbage `mode` value reaches the kernel is masked
 * down to zero permission bits — never accidentally permissive — instead of
 * trusting the unreliable vararg), lets the caller `fchmod` the returned
 * descriptor to the real desired mode (a fixed-arity, and therefore
 * reliable, libc call) while still inside the callback, and restores the
 * prior umask before returning. The whole sequence is synchronous — no
 * `await` ever separates the two `umask` calls — so no concurrent JS turn
 * can observe the temporarily widened process-global umask.
 */
export function withRestrictiveCreateMask<T>(
  symbols: LibcSymbols,
  fn: () => T,
): T {
  const previousMask = symbols.umask(0o777);
  try {
    return fn();
  } finally {
    symbols.umask(previousMask);
  }
}

export interface LoadedLibc {
  readonly library: ReturnType<typeof dlopen>;
  readonly symbols: LibcSymbols;
  /** Reads the calling thread's current `errno` via the platform's accessor symbol. Must be called immediately after the failing libc call, before any other libc call (including `close`) that could itself reset `errno`. */
  readonly readErrno: () => number;
}

const COMMON_LIBC_DEFINITIONS = {
  open: {
    args: ["ptr", "i32", "i32"],
    returns: "i32",
  },
  openat: {
    args: ["i32", "ptr", "i32", "i32"],
    returns: "i32",
  },
  mkdirat: {
    args: ["i32", "ptr", "u32"],
    returns: "i32",
  },
  close: { args: ["i32"], returns: "i32" },
  write: { args: ["i32", "ptr", "i32"], returns: "i32" },
  fchmod: { args: ["i32", "i32"], returns: "i32" },
  umask: { args: ["u32"], returns: "u32" },
  renameat: {
    args: ["i32", "ptr", "i32", "ptr"],
    returns: "i32",
  },
  unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
  fsync: { args: ["i32"], returns: "i32" },
  flock: { args: ["i32", "i32"], returns: "i32" },
} as const;

function makeLoadedLibc(
  library: ReturnType<typeof dlopen>,
  symbols: LibcSymbols,
  readErrno: () => number,
): LoadedLibc {
  return { library, symbols, readErrno };
}

function openLibc(
  libraryPath: string,
  errnoSymbol: ErrnoSymbolName,
): LoadedLibc {
  if (errnoSymbol === "__error") {
    const library = dlopen(libraryPath, {
      ...COMMON_LIBC_DEFINITIONS,
      __error: { args: [], returns: "ptr" },
    });
    const loaded = library.symbols;
    return makeLoadedLibc(
      library,
      loaded,
      () => {
        const pointer = loaded.__error();
        return pointer === null ? -1 : read.i32(pointer, 0);
      },
    );
  }

  const library = dlopen(libraryPath, {
    ...COMMON_LIBC_DEFINITIONS,
    __errno_location: { args: [], returns: "ptr" },
  });
  const loaded = library.symbols;
  return makeLoadedLibc(
    library,
    loaded,
    () => {
      const pointer = loaded.__errno_location();
      return pointer === null ? -1 : read.i32(pointer, 0);
    },
  );
}

export function loadLibc(): Result<LoadedLibc, NoFollowFfiError> {
  const libraryPath = libcPath();
  const errnoSymbol = errnoAccessorName();
  if (libraryPath === undefined || errnoSymbol === undefined) {
    return err({
      message: "no-follow filesystem I/O is unavailable on this platform",
    });
  }

  return Result.fromThrowable(
    () => openLibc(libraryPath, errnoSymbol),
    (cause) =>
      ({
        message: "failed to load libc for no-follow filesystem I/O",
        cause: sanitizeCause(cause),
      }) satisfies NoFollowFfiError,
  )();
}

/**
 * Single fstat-equivalent read of an open descriptor's identity via
 * `Bun.file(fd).stat()`. Enforces the expected kind (file or directory) in
 * the same call so no second stat/reopen is needed.
 */
export function identityFromFd(
  fd: number,
  expectedKind: "file" | "directory",
): ResultAsync<FdIdentity, NoFollowFfiError> {
  return ResultAsync.fromThrowable(
    () => Bun.file(fd).stat(),
    (cause) =>
      ({
        message: "failed to fstat no-follow descriptor",
        cause: sanitizeCause(cause),
      }) satisfies NoFollowFfiError,
  )().andThen((stat) => {
    const matchesKind =
      expectedKind === "file" ? stat.isFile() : stat.isDirectory();
    if (!matchesKind) {
      return errAsync({
        message:
          expectedKind === "file"
            ? "resolved target is not a regular file"
            : "resolved target is not a directory",
      } satisfies NoFollowFfiError);
    }
    return okAsync({
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  });
}

/**
 * Creates every missing component of an absolute directory path via
 * `mkdirat(AT_FDCWD, ...)` — a native libc call, never a shelled-out `mkdir`
 * process. Passing `AT_FDCWD` as the base directory makes `mkdirat` behave
 * exactly like `mkdir(path, mode)` for the absolute prefixes built here.
 *
 * This is a best-effort creation helper only: it does not, by itself, prove
 * any component is free of symlinks. Callers (the runtime directory guard)
 * still perform the actual no-follow `openat` walk that is the real security
 * boundary; if any component is a symlink, `mkdirat` no-ops on it (EEXIST,
 * since the symlink node already exists) without writing through it, and the
 * caller's subsequent no-follow open rejects it.
 */
export function ensureDirectoryTree(
  path: string,
  mode: number,
): ResultAsync<void, NoFollowFfiError> {
  const flags = platformFlags();
  if (flags === undefined) {
    return errAsync({
      message: "no-follow filesystem I/O is unavailable on this platform",
    });
  }
  const loaded = loadLibc();
  if (loaded.isErr()) return errAsync(loaded.error);
  const { library, symbols, readErrno } = loaded.value;

  const segments = path.split("/").filter((segment) => segment.length > 0);
  return ResultAsync.fromPromise(
    (async () => {
      let accumulated = "";
      for (const segment of segments) {
        accumulated += `/${segment}`;
        const rc = symbols.mkdirat(flags.AT_FDCWD, cstr(accumulated), mode);
        if (rc !== 0) {
          const errnoValue = readErrno();
          if (errnoValue !== ERRNO_EEXIST) {
            throw new Error(
              `mkdirat failed for a directory tree component (errno ${errnoValue})`,
            );
          }
        }
      }
    })(),
    (cause) =>
      ({
        message: "failed to create directory tree",
        cause: sanitizeCause(cause),
      }) satisfies NoFollowFfiError,
  ).andThen((value) =>
    toResultAsync(
      Result.fromThrowable(
        () => {
          library.close();
          return value;
        },
        (cause) =>
          ({
            message: "failed to close libc after creating directory tree",
            cause: sanitizeCause(cause),
          }) satisfies NoFollowFfiError,
      )(),
    ),
  );
}
