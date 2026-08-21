/**
 * Bun FFI no-follow descriptor primitives for the Pi path-containment
 * contract.
 *
 * This module owns libc loading, errno classification, realpath decoding,
 * descriptor-relative directory walks, and metadata-only entry inspection.
 * Every descriptor returned by an exported operation has an explicit owner;
 * callers close held descriptors, while inspection helpers close the
 * descriptor they open before settling.
 */

import { dlopen, ptr, read } from "bun:ffi";
import { platform } from "node:os";
import { isAbsolute } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type {
  NoFollowEntryIdentity,
  NoFollowInspectionError,
  PathContainmentError,
} from "./path-containment-contracts.js";

interface NoFollowOpenFlags {
  readonly O_RDONLY: number;
  readonly O_DIRECTORY: number;
  readonly O_NOFOLLOW: number;
  readonly O_CLOEXEC: number;
  /** Prevent a FIFO or other special file from blocking the identity read. */
  readonly O_NONBLOCK: number;
}

function noFollowOpenFlags(): NoFollowOpenFlags | undefined {
  const os = platform();
  if (os === "darwin") {
    return {
      O_RDONLY: 0x0000,
      O_DIRECTORY: 0x0010_0000,
      O_NOFOLLOW: 0x0100,
      O_CLOEXEC: 0x0100_0000,
      O_NONBLOCK: 0x0004,
    };
  }
  if (os === "linux") {
    return {
      O_RDONLY: 0,
      O_DIRECTORY: 0x1_0000,
      O_NOFOLLOW: 0x2_0000,
      O_CLOEXEC: 0x8_0000,
      O_NONBLOCK: 0x0800,
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

export function cstr(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`);
}

const PATH_MAX = 4_096;
const textDecoder = new TextDecoder();

export interface LoadedNoFollowLibc {
  readonly flags: NoFollowOpenFlags;
  readonly open: (path: Uint8Array, flags: number) => number;
  readonly openat: (dirFd: number, path: Uint8Array, flags: number) => number;
  readonly realpath: (path: Uint8Array, resolved: Uint8Array) => boolean;
  readonly close: (fd: number) => number;
  readonly errno: () => number;
  readonly dispose: () => void;
}

/** Dlopens libc's `open`/`openat`/`close` plus its errno accessor. Fails closed (never throws) when the platform is unsupported or the library fails to load. */
export function loadNoFollowLibc(): Result<
  LoadedNoFollowLibc,
  PathContainmentError
> {
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
        realpath: { args: ["ptr", "ptr"], returns: "ptr" },
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
      realpath: (path: Uint8Array, resolved: Uint8Array) => {
        const value = symbols.realpath(ptr(path), ptr(resolved));
        return value !== null && value !== undefined && value !== 0;
      },
      close: (fd: number) => symbols.close(fd) as number,
      errno: () => read.i32(symbols[errnoSymbol](), 0) as number,
      dispose: () => library.close(),
    };
  });
}

/** Only ENOENT ("no such file or directory") is a genuinely missing component; every other open failure (ELOOP for a symlink, ENOTDIR for a non-directory where one was required, EACCES, ...) is treated as an unsafe/rejected component rather than guessed at further - no-follow containment fails closed on anything it cannot positively prove safe. */
export function isMissingComponentErrno(errnoValue: number): boolean {
  return errnoValue === 2;
}

/** Decode one libc `realpath(3)` result without accepting an unterminated or relative value. */
function decodeResolvedPath(buffer: Uint8Array): string | undefined {
  const end = buffer.indexOf(0);
  if (end <= 0) return undefined;
  const resolved = textDecoder.decode(buffer.subarray(0, end));
  return isAbsolute(resolved) ? resolved : undefined;
}

export function canonicalizeExistingPath(
  libc: LoadedNoFollowLibc,
  path: string,
  failure: PathContainmentError,
): Result<string, PathContainmentError> {
  if (!isAbsolute(path)) return err(failure);
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return err(failure);
  }
  const resolved = new Uint8Array(PATH_MAX);
  const realpath = Result.fromThrowable(
    () => libc.realpath(cstr(path), resolved),
    () => false,
  )();
  if (realpath.isErr() || !realpath.value) return err(failure);
  const canonical = decodeResolvedPath(resolved);
  return canonical === undefined ? err(failure) : ok(canonical);
}

export function openNoFollowDirectoryChain(
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
function inspectionError(error: PathContainmentError): NoFollowInspectionError {
  switch (error) {
    case "resolved-target-outside-root":
      return { type: "unsafe-path" };
    case "path-component-missing":
      return { type: "missing" };
    case "symlink-component-rejected":
      return { type: "symlink-rejected" };
    case "target-unresolvable":
      return { type: "wrong-kind", kind: "file" };
    default:
      return { type: "unavailable" };
  }
}

export function absoluteNoFollowSegments(
  path: string,
): Result<readonly string[], NoFollowInspectionError> {
  if (!isAbsolute(path)) return err({ type: "unsafe-path" });
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return err({ type: "unsafe-path" });
  }
  return ok(segments);
}

function inspectOpenedEntry(
  libc: LoadedNoFollowLibc,
  fd: number,
  kind: "directory" | "file",
  mode: number,
): ResultAsync<NoFollowEntryIdentity, NoFollowInspectionError> {
  return ResultAsync.fromThrowable(
    () => Bun.file(fd).stat(),
    (): NoFollowInspectionError => ({ type: "io" }),
  )()
    .andThen((stat) => {
      if (
        (kind === "directory" && !stat.isDirectory()) ||
        (kind === "file" && !stat.isFile())
      ) {
        return errAsync<NoFollowEntryIdentity, NoFollowInspectionError>({
          type: "wrong-kind",
          kind,
        });
      }
      if ((stat.mode & 0o7777) !== mode) {
        return errAsync<NoFollowEntryIdentity, NoFollowInspectionError>({
          type: "permissive-mode",
          kind,
        });
      }
      return okAsync<NoFollowEntryIdentity, NoFollowInspectionError>({
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode & 0o7777,
      });
    })
    .map((identity) => {
      libc.close(fd);
      return identity;
    })
    .mapErr((error) => {
      libc.close(fd);
      return error;
    });
}

/**
 * Reopens an absolute directory through the same descriptor-relative
 * no-follow walk used by containment, then checks its identity and mode from
 * that descriptor. Callers use this beside a held descriptor to detect a
 * directory replaced at its path before mutating the held directory.
 */
export function inspectNoFollowDirectory(
  path: string,
  mode: number,
): ResultAsync<NoFollowEntryIdentity, NoFollowInspectionError> {
  const segments = absoluteNoFollowSegments(path);
  if (segments.isErr()) return errAsync(segments.error);
  const libcResult = loadNoFollowLibc();
  if (libcResult.isErr()) return errAsync(inspectionError(libcResult.error));
  const libc = libcResult.value;
  const opened = openNoFollowDirectoryChain(libc, "/", segments.value);
  if (opened.isErr()) {
    libc.dispose();
    return errAsync(inspectionError(opened.error));
  }
  return inspectOpenedEntry(libc, opened.value, "directory", mode)
    .map((identity) => {
      libc.dispose();
      return identity;
    })
    .mapErr((error) => {
      libc.dispose();
      return error;
    });
}

/**
 * Inspects one absolute regular file through its held parent descriptor. A
 * missing file is a successful `undefined`; symlinks, non-files, and modes
 * other than the requested private mode fail closed.
 */
export function inspectNoFollowFile(
  path: string,
  mode: number,
): ResultAsync<NoFollowEntryIdentity | undefined, NoFollowInspectionError> {
  const segments = absoluteNoFollowSegments(path);
  if (segments.isErr()) return errAsync(segments.error);
  const fileName = segments.value.at(-1);
  if (fileName === undefined) return errAsync({ type: "unsafe-path" });
  const libcResult = loadNoFollowLibc();
  if (libcResult.isErr()) return errAsync(inspectionError(libcResult.error));
  const libc = libcResult.value;
  const opened = openNoFollowDirectoryChain(
    libc,
    "/",
    segments.value.slice(0, -1),
  );
  if (opened.isErr()) {
    libc.dispose();
    return errAsync(inspectionError(opened.error));
  }
  const fileFd = libc.openat(
    opened.value,
    cstr(fileName),
    libc.flags.O_RDONLY | libc.flags.O_NOFOLLOW | libc.flags.O_CLOEXEC,
  );
  const openErrno = fileFd < 0 ? libc.errno() : undefined;
  libc.close(opened.value);
  if (fileFd < 0) {
    libc.dispose();
    if (isMissingComponentErrno(openErrno ?? -1)) return okAsync(undefined);
    return errAsync(
      openErrno === 40 ? { type: "symlink-rejected" } : { type: "io" },
    );
  }
  return inspectOpenedEntry(libc, fileFd, "file", mode)
    .map((identity) => {
      libc.dispose();
      return identity;
    })
    .mapErr((error) => {
      libc.dispose();
      return error;
    });
}
