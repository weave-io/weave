/**
 * Lexical path policy and project-root containment.
 *
 * This module owns the one relative-path policy, the canonical-root-relative
 * segment check used by trusted reads, and the production/fake containment
 * ports. The actual proof comes from the descriptor chain in the no-follow
 * module; this module decides which paths are eligible for that proof.
 */

import { isAbsolute, join } from "node:path";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import type {
  PathContainmentError,
  PathContainmentPort,
} from "./path-containment-contracts.js";
import {
  loadNoFollowLibc,
  openNoFollowDirectoryChain,
} from "./path-containment-nofollow.js";

/** True when `relativePath` is a non-empty, non-absolute path with no `..` segment. */
export function isLexicallyContained(relativePath: string): boolean {
  if (relativePath.length === 0) return false;
  if (isAbsolute(relativePath)) return false;
  const segments = relativePath.split(/[\\/]+/);
  return segments.every((segment) => segment !== ".." && segment.length > 0);
}

export function pathSegments(relativePath: string): readonly string[] {
  return relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/** Lift a synchronous `Result` into `ResultAsync` for use in async chains. */
export function toResultAsync<T, E>(result: Result<T, E>): ResultAsync<T, E> {
  return result.match(
    (value) => okAsync(value),
    (error) => errAsync(error),
  );
}

/**
 * Converts an already-canonical target back into root-relative components.
 * The result is later reopened through `openat` below that same root.
 */
export function canonicalRelativeSegments(
  root: string,
  target: string,
): Result<readonly string[], PathContainmentError> {
  const withinRoot =
    root === "/"
      ? target.startsWith("/")
      : target === root || target.startsWith(`${root}/`);
  if (!withinRoot) return err("resolved-target-outside-root");
  if (target === root) return ok([]);
  const suffix = root === "/" ? target.slice(1) : target.slice(root.length + 1);
  const segments = suffix.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return err("resolved-target-outside-root");
  }
  return ok(segments);
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
