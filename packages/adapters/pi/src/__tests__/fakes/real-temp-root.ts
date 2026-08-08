/**
 * Test-only helper for real-filesystem fixtures.
 *
 * Real-FS proofs need a *canonical* (symlink-free) temporary root: the adapter
 * opens session paths with a strict no-follow chain, so any symlinked prefix
 * (`/tmp` → `/private/tmp` on Darwin, `/var/folders/...` under `$TMPDIR`) would
 * make the fixture prove the wrong thing. This helper creates a unique
 * directory under the platform temporary directory and resolves it with
 * `/bin/pwd -P`, which is portable across macOS and Linux runners. The absolute
 * path bypasses Bun's shell builtin, which does not accept `-P`.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

/**
 * Creates a unique temporary directory under the platform temp dir and returns
 * its fully canonical (symlink-free) absolute path.
 */
export async function makeRealTempRoot(prefix: string): Promise<string> {
  const template = join(tmpdir(), `${prefix}-XXXXXX`);
  const created = (await $`mktemp -d ${template}`.quiet()).text().trim();
  return (await $`cd ${created} && /bin/pwd -P`.quiet()).text().trim();
}

/**
 * Returns a unique, canonical, *not yet created* path under the platform temp
 * dir. The parent directory is canonicalized so callers can assert on exact
 * absolute paths without symlink ambiguity.
 */
export async function reserveRealTempPath(prefix: string): Promise<string> {
  const base = (await $`cd ${tmpdir()} && /bin/pwd -P`.quiet()).text().trim();
  return join(base, `${prefix}-${crypto.randomUUID()}`);
}

/** Removes a directory tree created by {@link makeRealTempRoot}. */
export async function removeRealTempRoot(root: string): Promise<void> {
  await $`rm -rf ${root}`.quiet();
}
