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
import { dlopen, type Pointer } from "bun:ffi";
import { Result, ResultAsync } from "neverthrow";
/** Generic low-level FFI failure. Callers map this onto their own error type. */
export interface NoFollowFfiError {
    readonly message: string;
    readonly cause?: string;
}
export interface LibcSymbols {
    readonly open: (path: Pointer | TypedArray | string | null, flags: number, mode?: number) => number;
    readonly openat: (dirfd: number, path: Pointer | TypedArray | string | null, flags: number, mode?: number) => number;
    readonly mkdirat: (dirfd: number, path: Pointer | TypedArray | string | null, mode: number) => number;
    readonly close: (fd: number) => number;
    readonly write: (fd: number, buf: Pointer | TypedArray | string | null, count: number) => number;
    readonly fchmod: (fd: number, mode: number) => number;
    readonly umask: (mask: number) => number;
    readonly renameat: (olddirfd: number, oldpath: Pointer | TypedArray | string | null, newdirfd: number, newpath: Pointer | TypedArray | string | null) => number;
    readonly unlinkat: (dirfd: number, path: Pointer | TypedArray | string | null, flags: number) => number;
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
export declare const LOCK_SH = 1;
export declare const LOCK_EX = 2;
export declare const LOCK_NB = 4;
export declare const LOCK_UN = 8;
export type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;
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
export declare const ERRNO_ENOENT = 2;
/** POSIX `EEXIST` — portable across Darwin and Linux. */
export declare const ERRNO_EEXIST = 17;
export declare function platformFlags(): PlatformFlags | undefined;
export declare function libcPath(): string | undefined;
export declare function cstr(value: string): Uint8Array;
/** Lift a synchronous `Result` into `ResultAsync` for use in async chains. */
export declare function toResultAsync<T, E>(result: Result<T, E>): ResultAsync<T, E>;
/**
 * Extracts a safe-to-log description from a caught native/FFI failure.
 * Never interpolates the raw caught value: FFI throwables can carry
 * pointers, buffers, or other internal state that must not leak into logs
 * or typed error messages.
 */
export declare function sanitizeCause(cause: unknown): string;
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
export declare function withRestrictiveCreateMask<T>(symbols: LibcSymbols, fn: () => T): T;
export interface LoadedLibc {
    readonly library: ReturnType<typeof dlopen>;
    readonly symbols: LibcSymbols;
    /** Reads the calling thread's current `errno` via the platform's accessor symbol. Must be called immediately after the failing libc call, before any other libc call (including `close`) that could itself reset `errno`. */
    readonly readErrno: () => number;
}
export declare function loadLibc(): Result<LoadedLibc, NoFollowFfiError>;
/**
 * Single fstat-equivalent read of an open descriptor's identity via
 * `Bun.file(fd).stat()`. Enforces the expected kind (file or directory) in
 * the same call so no second stat/reopen is needed.
 */
export declare function identityFromFd(fd: number, expectedKind: "file" | "directory"): ResultAsync<FdIdentity, NoFollowFfiError>;
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
export declare function ensureDirectoryTree(path: string, mode: number): ResultAsync<void, NoFollowFfiError>;
