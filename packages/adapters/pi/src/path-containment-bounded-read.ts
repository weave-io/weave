/**
 * Bounded absolute-file reads and trusted-root parent binding.
 *
 * An explicit canonical root is the only case in which a parent symlink may
 * be followed. Its realpath is converted to root-relative segments, reopened
 * through the no-follow descriptor chain, and revalidated after the bounded
 * read. The final file is always opened with `O_NOFOLLOW` and checked through
 * its own descriptor.
 */

import { dirname } from "node:path";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import {
  captureBoundedFileIdentity,
  readBoundedFileObject,
  sameBoundedFileIdentity,
} from "./bounded-file-read.js";
import type {
  BoundedAbsoluteFileReadError,
  PathContainmentError,
} from "./path-containment-contracts.js";
import {
  canonicalRelativeSegments,
  toResultAsync,
} from "./path-containment-lexical.js";
import {
  absoluteNoFollowSegments,
  canonicalizeExistingPath,
  cstr,
  isMissingComponentErrno,
  type LoadedNoFollowLibc,
  loadNoFollowLibc,
  openNoFollowDirectoryChain,
} from "./path-containment-nofollow.js";

interface TrustedParentBinding {
  readonly canonicalRoot: string;
  readonly originalParent: string;
  readonly canonicalParent: string;
  readonly parentSegments: readonly string[];
}

/**
 * Resolves a parent symlink only when the caller supplies an expected
 * canonical root. The canonical target is converted back to root-relative
 * segments and reopened below that root, so realpath never becomes an
 * unbounded trust decision.
 */
function resolveTrustedParentBinding(
  libc: LoadedNoFollowLibc,
  path: string,
  expectedCanonicalRoot: string,
): Result<TrustedParentBinding, PathContainmentError> {
  const canonicalRoot = canonicalizeExistingPath(
    libc,
    expectedCanonicalRoot,
    "project-root-unresolvable",
  );
  if (canonicalRoot.isErr() || canonicalRoot.value !== expectedCanonicalRoot) {
    return err("project-root-unresolvable");
  }
  const originalParent = dirname(path);
  const canonicalParent = canonicalizeExistingPath(
    libc,
    originalParent,
    "target-unresolvable",
  );
  if (canonicalParent.isErr()) return err(canonicalParent.error);
  const parentSegments = canonicalRelativeSegments(
    canonicalRoot.value,
    canonicalParent.value,
  );
  if (parentSegments.isErr()) return err(parentSegments.error);
  return ok({
    canonicalRoot: canonicalRoot.value,
    originalParent,
    canonicalParent: canonicalParent.value,
    parentSegments: parentSegments.value,
  });
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

function readDirectoryIdentity(
  fd: number,
): ResultAsync<DirectoryIdentity, BoundedAbsoluteFileReadError> {
  return ResultAsync.fromThrowable(
    () => Bun.file(fd).stat(),
    (): BoundedAbsoluteFileReadError => "read-failed",
  )().andThen((stat) => {
    if (
      !stat.isDirectory() ||
      !Number.isSafeInteger(stat.dev) ||
      stat.dev < 0 ||
      !Number.isSafeInteger(stat.ino) ||
      stat.ino < 0
    ) {
      return errAsync<DirectoryIdentity, BoundedAbsoluteFileReadError>(
        "target-unresolvable",
      );
    }
    return okAsync<DirectoryIdentity, BoundedAbsoluteFileReadError>({
      dev: stat.dev,
      ino: stat.ino,
    });
  });
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Re-resolves and reopens the original parent after reading. This rejects a
 * parent symlink retarget, or a replacement of the target directory, before
 * bytes from the held descriptor are accepted.
 */
function verifyTrustedParentBinding(
  libc: LoadedNoFollowLibc,
  binding: TrustedParentBinding,
  openedIdentity: DirectoryIdentity,
): ResultAsync<void, BoundedAbsoluteFileReadError> {
  const currentParent = canonicalizeExistingPath(
    libc,
    binding.originalParent,
    "target-unresolvable",
  );
  if (currentParent.isErr()) {
    return errAsync<void, BoundedAbsoluteFileReadError>(currentParent.error);
  }
  if (currentParent.value !== binding.canonicalParent) {
    return errAsync<void, BoundedAbsoluteFileReadError>(
      "target-identity-changed",
    );
  }
  const reopened = openNoFollowDirectoryChain(
    libc,
    binding.canonicalRoot,
    binding.parentSegments,
  );
  if (reopened.isErr()) {
    return errAsync<void, BoundedAbsoluteFileReadError>(reopened.error);
  }
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    libc.close(reopened.value);
  };
  return readDirectoryIdentity(reopened.value)
    .andThen((currentIdentity) => {
      close();
      return sameDirectoryIdentity(openedIdentity, currentIdentity)
        ? okAsync<void, BoundedAbsoluteFileReadError>(undefined)
        : errAsync<void, BoundedAbsoluteFileReadError>(
            "target-identity-changed",
          );
    })
    .mapErr((error) => {
      close();
      return error;
    });
}
/**
 * Read an absolute regular file through one no-follow descriptor.
 *
 * The leaf is opened with `O_NOFOLLOW`, stat'ed before any body allocation, and
 * read through a `slice(0, maxBytes + 1)` sentinel. Descriptor identity is
 * checked before and after the read, and the named leaf is reopened against
 * the held parent descriptor before success so a replacement or symlink swap
 * cannot make the digest describe bytes that are no longer at `path`.
 *
 * Parent symlinks are rejected by default. A caller that has an explicit
 * canonical trust boundary may pass `expectedCanonicalRoot`; the parent is
 * then realpath-resolved, required to remain inside that root, reopened by
 * root-relative no-follow descriptors, and revalidated after the read.
 */
export function readAbsoluteFileBounded(
  path: string,
  maxBytes: number,
  expectedCanonicalRoot?: string,
): ResultAsync<Uint8Array, BoundedAbsoluteFileReadError> {
  const segments = absoluteNoFollowSegments(path);
  if (segments.isErr()) {
    return errAsync("resolved-target-outside-root");
  }
  const fileName = segments.value.at(-1);
  if (fileName === undefined) return errAsync("resolved-target-outside-root");

  const libcResult = loadNoFollowLibc();
  if (libcResult.isErr()) return errAsync(libcResult.error);
  const libc = libcResult.value;
  let binding: TrustedParentBinding | undefined;
  let openedParent: Result<number, PathContainmentError>;
  if (expectedCanonicalRoot === undefined) {
    openedParent = openNoFollowDirectoryChain(
      libc,
      "/",
      segments.value.slice(0, -1),
    );
  } else {
    const resolved = resolveTrustedParentBinding(
      libc,
      path,
      expectedCanonicalRoot,
    );
    if (resolved.isErr()) {
      libc.dispose();
      return errAsync(resolved.error);
    }
    binding = resolved.value;
    openedParent = openNoFollowDirectoryChain(
      libc,
      binding.canonicalRoot,
      binding.parentSegments,
    );
  }
  if (openedParent.isErr()) {
    libc.dispose();
    return errAsync(openedParent.error);
  }

  const read = ResultAsync.fromThrowable(
    async (): Promise<Result<Uint8Array, BoundedAbsoluteFileReadError>> => {
      const parentFd = openedParent.value;
      let fileFd: number | undefined;
      try {
        let openedParentIdentity: DirectoryIdentity | undefined;
        if (binding !== undefined) {
          const identity = await readDirectoryIdentity(parentFd);
          if (identity.isErr()) return err(identity.error);
          openedParentIdentity = identity.value;
        }

        fileFd = libc.openat(
          parentFd,
          cstr(fileName),
          libc.flags.O_RDONLY |
            libc.flags.O_NOFOLLOW |
            libc.flags.O_CLOEXEC |
            libc.flags.O_NONBLOCK,
        );
        if (fileFd < 0) {
          const openErrno = libc.errno();
          return err(
            isMissingComponentErrno(openErrno)
              ? "path-component-missing"
              : "symlink-component-rejected",
          );
        }

        const file = Bun.file(fileFd);
        const openedIdentity = captureBoundedFileIdentity(await file.stat());
        if (openedIdentity.isErr()) return err(openedIdentity.error);
        if (openedIdentity.value.size > maxBytes) {
          return err("file-too-large");
        }

        const bounded = await readBoundedFileObject(file, maxBytes);
        if (bounded.isErr()) return err(bounded.error);

        const currentFd = libc.openat(
          parentFd,
          cstr(fileName),
          libc.flags.O_RDONLY |
            libc.flags.O_NOFOLLOW |
            libc.flags.O_CLOEXEC |
            libc.flags.O_NONBLOCK,
        );
        if (currentFd < 0) {
          const currentErrno = libc.errno();
          return err(
            isMissingComponentErrno(currentErrno)
              ? "path-component-missing"
              : "file-changed",
          );
        }
        try {
          const currentIdentity = captureBoundedFileIdentity(
            await Bun.file(currentFd).stat(),
          );
          if (currentIdentity.isErr()) return err(currentIdentity.error);
          if (
            !sameBoundedFileIdentity(
              openedIdentity.value,
              currentIdentity.value,
            )
          ) {
            return err("file-changed");
          }
        } finally {
          libc.close(currentFd);
        }

        if (binding !== undefined && openedParentIdentity !== undefined) {
          const parentStillBound = await verifyTrustedParentBinding(
            libc,
            binding,
            openedParentIdentity,
          );
          if (parentStillBound.isErr()) return err(parentStillBound.error);
        }
        return ok(bounded.value);
      } finally {
        if (fileFd !== undefined && fileFd >= 0) libc.close(fileFd);
        libc.close(parentFd);
      }
    },
    (): BoundedAbsoluteFileReadError => "read-failed",
  )()
    .andThen(toResultAsync)
    .map((value) => {
      libc.dispose();
      return value;
    })
    .mapErr((error) => {
      libc.dispose();
      return error;
    });
  return read;
}
