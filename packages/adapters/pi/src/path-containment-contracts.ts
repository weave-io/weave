import type { ResultAsync } from "neverthrow";
import type { BoundedFileReadError } from "./bounded-file-read.js";

/** Closed set of ways a path can fail no-follow containment verification. */
export type PathContainmentError =
  | "project-root-unresolvable"
  | "path-component-missing"
  | "symlink-component-rejected"
  | "target-unresolvable"
  | "resolved-target-outside-root"
  | "target-identity-changed";

/**
 * Adapter-owned no-follow containment port. Every consumer that must prove
 * a relative *directory* path resolves safely inside a canonical project
 * root depends only on this narrow interface, never on process spawning
 * directly, so it stays testable with a fully scripted fake. Used for
 * read-only directory-existence probes; never for reading file bytes.
 */
export interface PathContainmentPort {
  /**
   * Walks every ancestor directory of `relativePath` under `canonicalRoot`,
   * rejecting the resolution if any path component - not just the final
   * leaf - is a symlink, and requiring the fully-resolved real path to remain
   * lexically inside `canonicalRoot`. Never creates, migrates, or writes.
   */
  verifyContainment(
    canonicalRoot: string,
    relativePath: string,
  ): ResultAsync<string, PathContainmentError>;
}

/** Stable identity and permission bits read from one no-follow descriptor. */
export interface NoFollowEntryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

/** Errors returned by the private-history no-follow inspection helpers. */
export type NoFollowInspectionError =
  | { readonly type: "unsafe-path" }
  | { readonly type: "missing" }
  | { readonly type: "symlink-rejected" }
  | { readonly type: "wrong-kind"; readonly kind: "directory" | "file" }
  | { readonly type: "permissive-mode"; readonly kind: "directory" | "file" }
  | { readonly type: "unavailable" }
  | { readonly type: "io" };

/** Closed failures for a bounded, absolute, no-follow file read. */
export type BoundedAbsoluteFileReadError =
  | BoundedFileReadError
  | PathContainmentError;

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
 * Bun-only no-follow relative-file provider. It reads a project-relative
 * regular file or lists a project-relative directory through held
 * descriptors opened with `O_NOFOLLOW`/`O_DIRECTORY | O_NOFOLLOW`.
 */
export interface SecureRelativeFileProvider {
  /**
   * Opens every ancestor directory of `relativePath` through a held
   * descriptor chain, then opens the final component as a regular file with
   * `O_NOFOLLOW`. `fstat` and read both use that descriptor.
   */
  readFile(
    canonicalRoot: string,
    relativePath: string,
  ): ResultAsync<SecureFileRead, PathContainmentError>;

  /**
   * Opens `relativeDir` through the held descriptor chain, then re-verifies
   * every discovered basename with `openat` and `O_NOFOLLOW` before including
   * it as a regular file.
   */
  listDirectory(
    canonicalRoot: string,
    relativeDir: string,
  ): ResultAsync<SecureDirectoryListing, PathContainmentError>;
}
