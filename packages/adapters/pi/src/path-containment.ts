/**
 * Shared, no-follow-safe path-containment primitives (Pi adapter contract).
 *
 * Every caller that must prove a relative path resolves safely inside a
 * canonical project root - artifact reads (Pi adapter contract), plan catalog
 * listing (Pi adapter contract), and the read-only Runtime Store/plan directory
 * containment probes used by capability probing (Pi adapter contract
 * "trust-withheld must not claim workflow persistence available") - shares
 * exactly one containment implementation instead of duplicating the
 * symlink-walk logic.
 *
 * `bun-types` ships no `fs.d.ts`, and `BunFile.stat()`/`Bun.file(path).bytes()`
 * follow symlinks and cannot themselves detect or reject a symlink
 * component, nor prove the bytes hashed came from the exact same no-follow
 * file identity a prior check inspected. `node:fs` is explicitly forbidden
 * runtime surface (AGENTS.md "Runtime — Bun Only"), and shelling out via
 * `Bun.$` for security containment is *also* forbidden: a subprocess-based
 * check is a separate process, a separate open, and a separate race window
 * from the actual read it is supposed to protect - a path-check-then-reopen
 * TOCTOU dressed up as a containment proof, never a genuine same-handle
 * no-follow guarantee (Pi adapter contract: "a path check followed by an
 * unrelated reopen is forbidden").
 *
 * Bun *does* expose a genuine no-follow primitive through its FFI bridge to
 * libc: `open`/`openat` called with `O_NOFOLLOW` (and, for directory
 * components, `O_DIRECTORY`) reject a symlink at open time, in the same
 * syscall that yields the descriptor everything else is read from - exactly
 * the pattern already proven safe in `@weaveio/weave-config`'s
 * `BunFilesystemPlanStateProvider` (`readNoFollow`) and
 * `@weaveio/weave-engine`'s `RotatingRuntimeLogSink`
 * (`BunNoFollowDirectoryHandle`/`BunNoFollowFileHandle`). This module
 * follows the same shape: open and hold the canonical project root, then
 * every ancestor directory component, via `openat(..., O_DIRECTORY |
 * O_NOFOLLOW)`, closing each previous descriptor as soon as the next is
 * open so containment is proven one held file-descriptor hop at a time -
 * never by reconstructing and reopening an absolute path string. The final
 * regular-file open likewise uses `O_NOFOLLOW` (no `O_DIRECTORY`), and its
 * bytes/identity are read from that exact same descriptor via
 * `Bun.file(fd)` - never a second, separate open by path.
 *
 * On a platform this module cannot prove safe (anything but darwin/linux,
 * or a libc that fails to load), every containment operation fails closed
 * exactly as before - "fail unavailable only on unsupported platforms",
 * never silently degrade to an unsafe path-based read.
 *
 * Tests must inject `FakePathContainmentPort`/`FakeSecureRelativeFileProvider`
 * to exercise the *safe* path of a caller (Pi adapter contract forbids real
 * process spawns in unit/integration tests); real-filesystem conformance is
 * covered separately by scratch-temp-directory tests (Pi adapter contract).
 */

import { dlopen, ptr, read } from "bun:ffi";
import { platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";

/** Closed set of ways a path can fail no-follow containment verification. */
export type PathContainmentError =
  | "project-root-unresolvable"
  | "path-component-missing"
  | "symlink-component-rejected"
  | "target-unresolvable"
  | "resolved-target-outside-root"
  | "target-identity-changed";

/** True when `relativePath` is a non-empty, non-absolute path with no `..` segment. */
export function isLexicallyContained(relativePath: string): boolean {
  if (relativePath.length === 0) return false;
  if (isAbsolute(relativePath)) return false;
  const segments = relativePath.split(/[\\/]+/);
  return segments.every((segment) => segment !== ".." && segment.length > 0);
}

function pathSegments(relativePath: string): readonly string[] {
  return relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/** Lift a synchronous `Result` into `ResultAsync` for use in async chains. */
function toResultAsync<T, E>(result: Result<T, E>): ResultAsync<T, E> {
  return result.match(
    (value) => okAsync(value),
    (error) => errAsync(error),
  );
}

/**
 * Adapter-owned no-follow containment port. Every consumer that must prove
 * a relative *directory* path resolves safely inside a canonical project
 * root depends only on this narrow interface, never on `Bun.$`/process
 * spawning directly, so it stays testable with a fully scripted fake
 * (Pi adapter contract). Used for read-only directory-existence probes
 * (`.weave/runtime`, `.weave/plans`) - never for reading file bytes; see
 * {@link SecureRelativeFileProvider} for that.
 */
export interface PathContainmentPort {
  /**
   * Walks every ancestor directory of `relativePath` under `canonicalRoot`,
   * rejecting the resolution if any path component - not just the final
   * leaf - is a symlink, and requiring the fully-resolved real path to
   * remain lexically inside `canonicalRoot`. Never creates, migrates, or
   * writes anything.
   */
  verifyContainment(
    canonicalRoot: string,
    relativePath: string,
  ): ResultAsync<string, PathContainmentError>;
}

// ---------------------------------------------------------------------------
// Bun FFI no-follow primitives
// ---------------------------------------------------------------------------

interface NoFollowOpenFlags {
  readonly O_RDONLY: number;
  readonly O_DIRECTORY: number;
  readonly O_NOFOLLOW: number;
  readonly O_CLOEXEC: number;
}

function noFollowOpenFlags(): NoFollowOpenFlags | undefined {
  const os = platform();
  if (os === "darwin") {
    return {
      O_RDONLY: 0x0000,
      O_DIRECTORY: 0x0010_0000,
      O_NOFOLLOW: 0x0100,
      O_CLOEXEC: 0x0100_0000,
    };
  }
  if (os === "linux") {
    return {
      O_RDONLY: 0,
      O_DIRECTORY: 0x1_0000,
      O_NOFOLLOW: 0x2_0000,
      O_CLOEXEC: 0x8_0000,
    };
  }
  return undefined;
}

function libcPath(): string | undefined {
  const os = platform();
  if (os === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (os === "linux") return "libc.so.6";
  return undefined;
}

/** libc exposes the calling thread's `errno` only through this accessor function - there is no plain exported symbol to read. */
function errnoAccessorName(): string | undefined {
  const os = platform();
  if (os === "darwin") return "__error";
  if (os === "linux") return "__errno_location";
  return undefined;
}

function cstr(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`);
}

interface LoadedNoFollowLibc {
  readonly flags: NoFollowOpenFlags;
  readonly open: (path: Uint8Array, flags: number) => number;
  readonly openat: (dirFd: number, path: Uint8Array, flags: number) => number;
  readonly close: (fd: number) => number;
  readonly errno: () => number;
  readonly dispose: () => void;
}

/** Dlopens libc's `open`/`openat`/`close` plus its errno accessor. Fails closed (never throws) when the platform is unsupported or the library fails to load. */
function loadNoFollowLibc(): Result<LoadedNoFollowLibc, PathContainmentError> {
  const flags = noFollowOpenFlags();
  const libraryPath = libcPath();
  const errnoSymbol = errnoAccessorName();
  if (
    flags === undefined ||
    libraryPath === undefined ||
    errnoSymbol === undefined
  ) {
    return err("project-root-unresolvable");
  }
  const loaded = Result.fromThrowable(
    () =>
      dlopen(libraryPath, {
        open: { args: ["ptr", "i32", "i32"], returns: "i32" },
        openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
        close: { args: ["i32"], returns: "i32" },
        [errnoSymbol]: { args: [], returns: "ptr" },
      }),
    (): PathContainmentError => "project-root-unresolvable",
  )();
  return loaded.map((library) => {
    // biome-ignore lint/suspicious/noExplicitAny: dlopen's symbol map is keyed by a runtime-computed platform name.
    const symbols = library.symbols as any;
    return {
      flags,
      open: (path: Uint8Array, openFlags: number) =>
        symbols.open(ptr(path), openFlags, 0) as number,
      openat: (dirFd: number, path: Uint8Array, openFlags: number) =>
        symbols.openat(dirFd, ptr(path), openFlags, 0) as number,
      close: (fd: number) => symbols.close(fd) as number,
      errno: () => read.i32(symbols[errnoSymbol](), 0) as number,
      dispose: () => library.close(),
    };
  });
}

/** Only ENOENT ("no such file or directory") is a genuinely missing component; every other open failure (ELOOP for a symlink, ENOTDIR for a non-directory where one was required, EACCES, ...) is treated as an unsafe/rejected component rather than guessed at further - no-follow containment fails closed on anything it cannot positively prove safe. */
function isMissingComponentErrno(errnoValue: number): boolean {
  return errnoValue === 2;
}

/**
 * Opens `canonicalRoot`, then walks `segments` one at a time via `openat`
 * with `O_DIRECTORY | O_NOFOLLOW`, closing each previous descriptor as soon
 * as the next is open so at most one directory descriptor is ever held at a
 * time. Returns the final held descriptor; the caller owns closing it.
 * Never reopens by absolute path once the walk has started - every step
 * after the root is relative to the previously-verified descriptor, so
 * escaping the root or substituting a symlinked ancestor is structurally
 * impossible, not merely checked for.
 */
function openNoFollowDirectoryChain(
  libc: LoadedNoFollowLibc,
  canonicalRoot: string,
  segments: readonly string[],
): Result<number, PathContainmentError> {
  const rootFd = libc.open(
    cstr(canonicalRoot),
    libc.flags.O_RDONLY |
      libc.flags.O_DIRECTORY |
      libc.flags.O_NOFOLLOW |
      libc.flags.O_CLOEXEC,
  );
  if (rootFd < 0) return err("project-root-unresolvable");
  let currentFd = rootFd;
  for (const segment of segments) {
    const nextFd = libc.openat(
      currentFd,
      cstr(segment),
      libc.flags.O_RDONLY |
        libc.flags.O_DIRECTORY |
        libc.flags.O_NOFOLLOW |
        libc.flags.O_CLOEXEC,
    );
    if (nextFd < 0) {
      const missing = isMissingComponentErrno(libc.errno());
      libc.close(currentFd);
      return err(
        missing ? "path-component-missing" : "symlink-component-rejected",
      );
    }
    libc.close(currentFd);
    currentFd = nextFd;
  }
  return ok(currentFd);
}

/**
 * Fully no-follow-safe production port (Pi adapter contract): proves every
 * directory component of `relativePath` under `canonicalRoot` via a held
 * `openat(O_DIRECTORY | O_NOFOLLOW)` chain (see file header). Reports the
 * resolved absolute path as proof on success - this string is purely
 * descriptive; containment itself was already established by the
 * descriptor chain before it was computed. Never creates, migrates, or
 * writes anything. Fails unavailable only when the platform/libc cannot
 * support the no-follow primitive at all.
 */
export class BunPathContainmentPort implements PathContainmentPort {
  verifyContainment(
    canonicalRoot: string,
    relativePath: string,
  ): ResultAsync<string, PathContainmentError> {
    if (!isLexicallyContained(relativePath)) {
      return errAsync("resolved-target-outside-root");
    }
    return toResultAsync(
      this.verifyContainmentSync(canonicalRoot, relativePath),
    );
  }

  private verifyContainmentSync(
    canonicalRoot: string,
    relativePath: string,
  ): Result<string, PathContainmentError> {
    const libcResult = loadNoFollowLibc();
    if (libcResult.isErr()) return err(libcResult.error);
    const libc = libcResult.value;
    try {
      const chain = openNoFollowDirectoryChain(
        libc,
        canonicalRoot,
        pathSegments(relativePath),
      );
      if (chain.isErr()) return err(chain.error);
      libc.close(chain.value);
      return ok(join(canonicalRoot, relativePath));
    } finally {
      libc.dispose();
    }
  }
}

/** Always fail-closed (unproven); the safe default when a caller omits an explicit port. Never spawns a process, never touches the filesystem. */
export class NullPathContainmentPort implements PathContainmentPort {
  verifyContainment(
    _canonicalRoot: string,
    _relativePath: string,
  ): ResultAsync<string, PathContainmentError> {
    return errAsync("project-root-unresolvable");
  }
}

/** Scripted fake for isolated tests (Pi adapter contract) - never spawns a real process. */
export class FakePathContainmentPort implements PathContainmentPort {
  constructor(
    private readonly results: ReadonlyMap<
      string,
      Result<string, PathContainmentError>
    >,
    private readonly defaultResult: Result<string, PathContainmentError> = err(
      "project-root-unresolvable",
    ),
  ) {}

  verifyContainment(
    canonicalRoot: string,
    relativePath: string,
  ): ResultAsync<string, PathContainmentError> {
    const key = `${canonicalRoot}\u0000${relativePath}`;
    const result = this.results.get(key) ?? this.defaultResult;
    return toResultAsync(result);
  }
}

/**
 * Read-only directory-containment probe (Pi adapter contract): proves a project
 * subdirectory either resolves safely inside the canonical project root, or
 * does not exist yet (safe to create later) - never that it is reachable
 * only through a rejected symlink or path escape. Never creates, migrates,
 * or writes anything; a missing directory is reported `true` (safe), and
 * every other `PathContainmentError` is reported `false` (unsafe/unproven).
 */
export function isDirectoryContainmentSafeWith(
  port: PathContainmentPort,
  projectRoot: string,
  relativeDir: string,
): ResultAsync<boolean, never> {
  if (!isLexicallyContained(relativeDir)) return okAsync(false);
  return port
    .verifyContainment(projectRoot, relativeDir)
    .map(() => true)
    .orElse((error) => okAsync(error === "path-component-missing"));
}

// ---------------------------------------------------------------------------
// SecureRelativeFileProvider — content reads and directory listings
// ---------------------------------------------------------------------------

/** Stable on-disk identity, read from a single held descriptor's `fstat`. */
export interface SecureFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface SecureFileRead {
  readonly bytes: Uint8Array;
  readonly identity: SecureFileIdentity;
}

export interface SecureDirectoryListing {
  readonly resolvedPath: string;
  /** Verified regular-file basenames only (no symlinks, no subdirectories), in the order the underlying scan produced them - callers that need a deterministic order must sort. */
  readonly fileNames: readonly string[];
}

/**
 * Bun-only no-follow relative-file provider (Pi adapter contract): reads
 * a project-relative regular file's bytes, or lists a project-relative
 * directory's regular-file basenames, entirely through held file
 * descriptors opened with `O_NOFOLLOW`/`O_DIRECTORY | O_NOFOLLOW` - never a
 * lexical check followed by a separate path-based reopen. Every consumer
 * that must read artifact/plan-catalog bytes depends only on this
 * interface, never on `node:fs`, `Bun.$`, or shell commands.
 */
export interface SecureRelativeFileProvider {
  /**
   * Opens every ancestor directory of `relativePath` via the same
   * `openNoFollowDirectoryChain` used by {@link PathContainmentPort}, then
   * opens the final component as a regular file with `O_NOFOLLOW` (no
   * `O_DIRECTORY`). `fstat`/read both happen against that exact same
   * descriptor via `Bun.file(fd)`, so the identity reported and the bytes
   * read can never diverge from what was actually opened.
   */
  readFile(
    canonicalRoot: string,
    relativePath: string,
  ): ResultAsync<SecureFileRead, PathContainmentError>;

  /**
   * Opens `relativeDir` via the same held-descriptor chain, then verifies
   * each candidate basename found there by `openat`-ing it (against the
   * already-held directory descriptor - never a fresh path-based open) with
   * `O_NOFOLLOW` and confirming it is a regular file before including it.
   * Candidate basenames themselves are discovered via `Bun.Glob` scanning
   * the already-verified resolved path (name discovery only, mirroring
   * `RotatingRuntimeLogSink.listRelative`'s established pattern) - every
   * name is then re-verified through the held descriptor before inclusion,
   * so a symlinked entry can never be reported as a safe regular file.
   */
  listDirectory(
    canonicalRoot: string,
    relativeDir: string,
  ): ResultAsync<SecureDirectoryListing, PathContainmentError>;
}

function identityFromStat(stat: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}): SecureFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * Opens the ancestor-directory chain for `relativePath`'s parent, then the
 * final component as a regular file with `O_NOFOLLOW`, and reads its
 * identity/bytes from that one held descriptor. A single `try/finally`
 * guarantees the file descriptor is closed exactly once regardless of
 * outcome - the only `try/catch` boundary in this function wraps the two
 * awaited Bun file operations, converting any unexpected rejection into the
 * same closed `target-unresolvable` outcome an explicit non-regular-file
 * check would produce.
 */
async function readSecureFile(
  libc: LoadedNoFollowLibc,
  canonicalRoot: string,
  relativePath: string,
): Promise<Result<SecureFileRead, PathContainmentError>> {
  const segments = pathSegments(relativePath);
  const fileName = segments[segments.length - 1];
  const parentSegments = segments.slice(0, -1);
  if (fileName === undefined) return err("resolved-target-outside-root");
  const chain = openNoFollowDirectoryChain(libc, canonicalRoot, parentSegments);
  if (chain.isErr()) return err(chain.error);
  const dirFd = chain.value;
  const fileFd = libc.openat(
    dirFd,
    cstr(fileName),
    libc.flags.O_RDONLY | libc.flags.O_NOFOLLOW | libc.flags.O_CLOEXEC,
  );
  // Read errno immediately - before any other libc call, including
  // `close()`, which can itself reset the calling thread's errno and
  // corrupt the missing-vs-symlink-rejected classification below.
  const openErrno = fileFd < 0 ? libc.errno() : undefined;
  libc.close(dirFd);
  if (fileFd < 0) {
    const missing = isMissingComponentErrno(openErrno ?? -1);
    return err(
      missing ? "path-component-missing" : "symlink-component-rejected",
    );
  }
  try {
    const stat = await Bun.file(fileFd).stat();
    if (!stat.isFile()) return err("target-unresolvable");
    const bytes = await Bun.file(fileFd).bytes();
    return ok({ bytes, identity: identityFromStat(stat) });
  } catch {
    return err("target-unresolvable");
  } finally {
    libc.close(fileFd);
  }
}

/**
 * Opens `relativeDir` via the held-descriptor chain, discovers candidate
 * basenames by scanning the already-verified resolved path (name discovery
 * only, mirroring `RotatingRuntimeLogSink.listRelative`'s established
 * pattern), then re-verifies each candidate by `openat`-ing it against the
 * held directory descriptor with `O_NOFOLLOW` and confirming a regular-file
 * `fstat` before including it - a symlinked or non-regular entry can never
 * be reported as a safe file. One `try/catch/finally` boundary guarantees
 * the directory descriptor closes exactly once and converts any unexpected
 * scan/stat rejection into a closed `target-unresolvable` outcome.
 */
async function listSecureDirectory(
  libc: LoadedNoFollowLibc,
  canonicalRoot: string,
  relativeDir: string,
): Promise<Result<SecureDirectoryListing, PathContainmentError>> {
  const chain = openNoFollowDirectoryChain(
    libc,
    canonicalRoot,
    pathSegments(relativeDir),
  );
  if (chain.isErr()) return err(chain.error);
  const dirFd = chain.value;
  const resolvedPath = join(canonicalRoot, relativeDir);
  try {
    const candidates: string[] = [];
    for await (const name of new Bun.Glob("*").scan({
      cwd: resolvedPath,
      onlyFiles: false,
      dot: false,
    })) {
      candidates.push(name);
    }
    const fileNames: string[] = [];
    for (const name of candidates) {
      const entryFd = libc.openat(
        dirFd,
        cstr(name),
        libc.flags.O_RDONLY | libc.flags.O_NOFOLLOW | libc.flags.O_CLOEXEC,
      );
      if (entryFd < 0) continue;
      try {
        const stat = await Bun.file(entryFd).stat();
        if (stat.isFile()) fileNames.push(name);
      } finally {
        // Every opened entry descriptor closes exactly once, even when
        // `stat()` rejects - the outer try/finally only owns `dirFd`.
        libc.close(entryFd);
      }
    }
    return ok({ resolvedPath, fileNames });
  } catch {
    return err("target-unresolvable");
  } finally {
    libc.close(dirFd);
  }
}

export class BunSecureRelativeFileProvider
  implements SecureRelativeFileProvider
{
  readFile(
    canonicalRoot: string,
    relativePath: string,
  ): ResultAsync<SecureFileRead, PathContainmentError> {
    if (!isLexicallyContained(relativePath)) {
      return errAsync("resolved-target-outside-root");
    }
    const libcResult = loadNoFollowLibc();
    if (libcResult.isErr()) return errAsync(libcResult.error);
    const libc = libcResult.value;
    return ResultAsync.fromSafePromise(
      readSecureFile(libc, canonicalRoot, relativePath).finally(() =>
        libc.dispose(),
      ),
    ).andThen(toResultAsync);
  }

  listDirectory(
    canonicalRoot: string,
    relativeDir: string,
  ): ResultAsync<SecureDirectoryListing, PathContainmentError> {
    if (!isLexicallyContained(relativeDir)) {
      return errAsync("resolved-target-outside-root");
    }
    const libcResult = loadNoFollowLibc();
    if (libcResult.isErr()) return errAsync(libcResult.error);
    const libc = libcResult.value;
    return ResultAsync.fromSafePromise(
      listSecureDirectory(libc, canonicalRoot, relativeDir).finally(() =>
        libc.dispose(),
      ),
    ).andThen(toResultAsync);
  }
}

/** Scripted fake for isolated tests (Pi adapter contract) - never touches the real filesystem. */
export class FakeSecureRelativeFileProvider
  implements SecureRelativeFileProvider
{
  constructor(
    private readonly files: ReadonlyMap<
      string,
      Result<SecureFileRead, PathContainmentError>
    > = new Map(),
    private readonly directories: ReadonlyMap<
      string,
      Result<SecureDirectoryListing, PathContainmentError>
    > = new Map(),
    private readonly defaultFileResult: Result<
      SecureFileRead,
      PathContainmentError
    > = err("project-root-unresolvable"),
    private readonly defaultDirectoryResult: Result<
      SecureDirectoryListing,
      PathContainmentError
    > = err("project-root-unresolvable"),
  ) {}

  readFile(
    canonicalRoot: string,
    relativePath: string,
  ): ResultAsync<SecureFileRead, PathContainmentError> {
    if (!isLexicallyContained(relativePath)) {
      return errAsync("resolved-target-outside-root");
    }
    const key = `${canonicalRoot}\u0000${relativePath}`;
    return toResultAsync(this.files.get(key) ?? this.defaultFileResult);
  }

  listDirectory(
    canonicalRoot: string,
    relativeDir: string,
  ): ResultAsync<SecureDirectoryListing, PathContainmentError> {
    if (!isLexicallyContained(relativeDir)) {
      return errAsync("resolved-target-outside-root");
    }
    const key = `${canonicalRoot}\u0000${relativeDir}`;
    return toResultAsync(
      this.directories.get(key) ?? this.defaultDirectoryResult,
    );
  }
}
