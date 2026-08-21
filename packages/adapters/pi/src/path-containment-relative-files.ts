/**
 * Relative project-file reads and directory listings.
 *
 * Names are discovered only after a no-follow directory descriptor is held.
 * Every candidate is reopened against that descriptor with `O_NOFOLLOW`; the
 * bytes and identity of a read come from the same final descriptor.
 */

import { join } from "node:path";
import { err, errAsync, ok, type Result, ResultAsync } from "neverthrow";
import type {
  PathContainmentError,
  SecureDirectoryListing,
  SecureFileIdentity,
  SecureFileRead,
  SecureRelativeFileProvider,
} from "./path-containment-contracts.js";
import {
  isLexicallyContained,
  pathSegments,
  toResultAsync,
} from "./path-containment-lexical.js";
import {
  cstr,
  isMissingComponentErrno,
  type LoadedNoFollowLibc,
  loadNoFollowLibc,
  openNoFollowDirectoryChain,
} from "./path-containment-nofollow.js";

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
