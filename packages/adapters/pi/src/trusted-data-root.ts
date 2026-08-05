/**
 * Canonicalization of the *trusted* XDG data base that Weave-owned adapter
 * storage hangs off (Pi adapter contract, Task 20 real-harness remediation).
 *
 * Adapter storage below `weave/adapters/pi/...` is opened with a strict
 * `openat(O_NOFOLLOW)` chain that refuses every symlinked component. That
 * rule is correct *inside* adapter-owned directories, but it is wrong at the
 * base: a user may legitimately keep `$HOME/.local` (or `$XDG_DATA_HOME`) as
 * a symlink into a dotfiles checkout. Refusing that base made delegation fail
 * with `thread-session-create-failed` before any child was spawned.
 *
 * This module draws the boundary explicitly. The *configured base* -
 * `$XDG_DATA_HOME`, or `$HOME/.local/share` when unset - may contain
 * symlinks, so it is canonicalized once with libc `realpath(3)` and then
 * proven trustworthy:
 *
 * - the canonical base must be absolute,
 * - its deepest existing ancestor must be a directory,
 * - it must be owned by the current uid (no foreign-owned base),
 * - it must not be group- or world-writable (no shared-writable base).
 *
 * Components that do not exist yet are never resolved through `realpath`;
 * they are appended to the canonical existing ancestor and created later by
 * the adapter's own no-follow chain with 0700 modes. So every path segment is
 * either canonicalized-and-trusted (at or above the base) or created and
 * verified no-follow (at or below the adapter root). Nothing below the base
 * may be a symlink, and this module never speaks for anything down there.
 *
 * `node:fs` is forbidden runtime surface and `Bun.$` cannot prove anything
 * about the handle a later read uses, so canonicalization goes through the
 * same `bun:ffi` libc bridge the rest of the adapter's containment code uses.
 * The ownership/mode check reads `Bun.file(canonical).stat()`, which follows
 * symlinks - harmless here precisely because `realpath` already removed every
 * symlink from the path it is given. On a platform this module cannot prove
 * safe, it fails closed.
 */

import { dlopen, ptr } from "bun:ffi";
import { platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";

/** Why a configured data base could not be trusted as a storage root. */
export type PiTrustedDataRootViolation =
  | "relative-data-root"
  | "unresolvable-data-root"
  | "non-directory-data-root"
  | "foreign-data-root"
  | "writable-data-root"
  | "data-root-unavailable";

/**
 * Canonicalizes a configured data base. Implementations may follow symlinks
 * *at or above* the base; they never speak for anything below it.
 */
export interface PiTrustedDataRootPort {
  canonicalize(base: string): ResultAsync<string, PiTrustedDataRootViolation>;
}

const PATH_MAX = 4096;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function cstr(value: string): Uint8Array {
  return textEncoder.encode(`${value}\0`);
}

interface TrustedRootLibc {
  /** True when `resolved` was filled with a canonical absolute path. */
  readonly realpath: (path: Uint8Array, resolved: Uint8Array) => boolean;
  /** True when `path` itself is a symbolic link. */
  readonly isSymlink: (path: Uint8Array) => boolean;
  readonly getuid: () => number;
  readonly dispose: () => void;
}

function libcPath(): string | undefined {
  const os = platform();
  if (os === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (os === "linux") return "libc.so.6";
  return undefined;
}

function loadTrustedRootLibc(): Result<
  TrustedRootLibc,
  PiTrustedDataRootViolation
> {
  const libraryPath = libcPath();
  if (libraryPath === undefined) return err("data-root-unavailable");
  return Result.fromThrowable(
    () =>
      dlopen(libraryPath, {
        realpath: { args: ["ptr", "ptr"], returns: "ptr" },
        readlink: { args: ["ptr", "ptr", "u64"], returns: "i64" },
        getuid: { args: [], returns: "u32" },
      }),
    (): PiTrustedDataRootViolation => "data-root-unavailable",
  )().map((library) => {
    const symbols = library.symbols as unknown as {
      realpath: (path: unknown, resolved: unknown) => unknown;
      readlink: (
        path: unknown,
        buffer: unknown,
        size: number,
      ) => bigint | number;
      getuid: () => number;
    };
    return {
      realpath: (path: Uint8Array, resolved: Uint8Array) => {
        // A null/zero return means the path could not be resolved: missing
        // component, symlink loop, dangling link, or denied traversal.
        const returned = symbols.realpath(ptr(path), ptr(resolved));
        return returned !== null && returned !== undefined && returned !== 0;
      },
      isSymlink: (path: Uint8Array) => {
        // `readlink` only succeeds on a symlink itself, so it separates a
        // component that does not exist from one that is a dangling or
        // looping link. Links below the trusted base are never followed.
        const buffer = new Uint8Array(PATH_MAX);
        const written = symbols.readlink(ptr(path), ptr(buffer), PATH_MAX);
        return BigInt(written) >= 0n;
      },
      getuid: () => symbols.getuid(),
      dispose: () => library.close(),
    } satisfies TrustedRootLibc;
  });
}

function decodeResolved(buffer: Uint8Array): string | undefined {
  const end = buffer.indexOf(0);
  if (end <= 0) return undefined;
  return textDecoder.decode(buffer.subarray(0, end));
}

function segmentsOf(path: string): readonly string[] {
  return path.split(/\/+/).filter((segment) => segment.length > 0);
}

interface ResolvedBase {
  /** Deepest existing ancestor, fully canonical (no symlink components). */
  readonly canonical: string;
  /** Components below it that do not exist yet, outermost first. */
  readonly missing: readonly string[];
}

/**
 * Resolves the deepest existing ancestor of `base` through `realpath`, and
 * reports the components below it that do not exist yet. Missing components
 * are never resolved; the caller creates them no-follow.
 */
function resolveExistingAncestor(
  libc: TrustedRootLibc,
  base: string,
): Result<ResolvedBase, PiTrustedDataRootViolation> {
  const segments = segmentsOf(base);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    // `.`/`..` are only meaningful against an existing prefix; a base that
    // needs them is refused rather than partially guessed at.
    return err("unresolvable-data-root");
  }
  const missing: string[] = [];
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const candidate = `/${segments.slice(0, depth).join("/")}`;
    const buffer = new Uint8Array(PATH_MAX);
    if (libc.realpath(cstr(candidate), buffer)) {
      const canonical = decodeResolved(buffer);
      if (canonical === undefined || !isAbsolute(canonical)) {
        return err("unresolvable-data-root");
      }
      return ok({ canonical, missing: [...missing].reverse() });
    }
    const consumed = segments[depth - 1];
    if (consumed !== undefined) missing.push(consumed);
  }
  return err("unresolvable-data-root");
}

/**
 * Refuses a base whose not-yet-existing components are actually symlinks -
 * dangling or looping links that `realpath` could not resolve. Such a
 * component would later be opened `O_NOFOLLOW` and rejected anyway; refusing
 * it here keeps the failure typed and keeps the trusted base symlink-free
 * below its canonical ancestor.
 */
function rejectSymlinkedMissingComponents(
  libc: TrustedRootLibc,
  resolved: ResolvedBase,
): Result<void, PiTrustedDataRootViolation> {
  let current = resolved.canonical;
  for (const segment of resolved.missing) {
    current = join(current, segment);
    if (libc.isSymlink(cstr(current))) {
      return err("unresolvable-data-root");
    }
  }
  return ok(undefined);
}

function verifyTrustedDirectory(
  libc: TrustedRootLibc,
  canonical: string,
): ResultAsync<void, PiTrustedDataRootViolation> {
  return ResultAsync.fromThrowable(
    () => Bun.file(canonical).stat(),
    (): PiTrustedDataRootViolation => "unresolvable-data-root",
  )().andThen((stat) => {
    if (!stat.isDirectory()) {
      return errAsync<void, PiTrustedDataRootViolation>(
        "non-directory-data-root",
      );
    }
    if (stat.uid !== libc.getuid()) {
      return errAsync<void, PiTrustedDataRootViolation>("foreign-data-root");
    }
    if ((stat.mode & 0o022) !== 0) {
      return errAsync<void, PiTrustedDataRootViolation>("writable-data-root");
    }
    return okAsync<void, PiTrustedDataRootViolation>(undefined);
  });
}

/**
 * Production canonicalizer: libc `realpath(3)` plus ownership and
 * shared-writability checks on the deepest existing ancestor.
 */
export class BunPiTrustedDataRootPort implements PiTrustedDataRootPort {
  canonicalize(base: string): ResultAsync<string, PiTrustedDataRootViolation> {
    if (base.length === 0 || !isAbsolute(base)) {
      return errAsync("relative-data-root");
    }
    const loaded = loadTrustedRootLibc();
    if (loaded.isErr()) return errAsync(loaded.error);
    const libc = loaded.value;
    const resolved = resolveExistingAncestor(libc, base);
    if (resolved.isErr()) {
      libc.dispose();
      return errAsync(resolved.error);
    }
    const { canonical, missing } = resolved.value;
    const symlinkCheck = rejectSymlinkedMissingComponents(libc, resolved.value);
    if (symlinkCheck.isErr()) {
      libc.dispose();
      return errAsync(symlinkCheck.error);
    }
    return verifyTrustedDirectory(libc, canonical)
      .map(() => {
        libc.dispose();
        return join(canonical, ...missing);
      })
      .mapErr((error) => {
        libc.dispose();
        return error;
      });
  }
}

/** The production trusted-data-root canonicalizer. */
export function createBunPiTrustedDataRootPort(): PiTrustedDataRootPort {
  return new BunPiTrustedDataRootPort();
}

/**
 * Identity canonicalizer for unit tests that use synthetic absolute paths
 * with no real filesystem behind them. Never touches the filesystem.
 */
export class IdentityPiTrustedDataRootPort implements PiTrustedDataRootPort {
  canonicalize(base: string): ResultAsync<string, PiTrustedDataRootViolation> {
    if (base.length === 0 || !isAbsolute(base)) {
      return errAsync("relative-data-root");
    }
    return okAsync(base);
  }
}

/** Scripted fake for tests that must exercise one specific violation. */
export class FakePiTrustedDataRootPort implements PiTrustedDataRootPort {
  constructor(
    private readonly results: ReadonlyMap<
      string,
      Result<string, PiTrustedDataRootViolation>
    >,
    private readonly defaultResult: Result<
      string,
      PiTrustedDataRootViolation
    > = err("unresolvable-data-root"),
  ) {}

  canonicalize(base: string): ResultAsync<string, PiTrustedDataRootViolation> {
    const result = this.results.get(base) ?? this.defaultResult;
    return result.match(
      (value) => okAsync<string, PiTrustedDataRootViolation>(value),
      (error) => errAsync<string, PiTrustedDataRootViolation>(error),
    );
  }
}
