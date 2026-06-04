/**
 * Migration plan construction.
 *
 * Resolves canonical source and destination paths for a given migration scope,
 * and builds the MigrationPlan descriptor used throughout the migration flow.
 */

import { resolve } from "node:path";
import type { ResultAsync } from "neverthrow";
import { describeFileSystemError, type FileSystem } from "../fs/file-system.js";
import type { MigrationPlan, MigrationScope } from "./types.js";

// ---------------------------------------------------------------------------
// Canonical path constants
// ---------------------------------------------------------------------------

/**
 * Canonical legacy source paths, keyed by scope.
 * These are relative to the scope root (home or cwd).
 */
export const LEGACY_SOURCE_RELATIVE: Record<MigrationScope, string> = {
  global: ".config/opencode/weave-opencode.jsonc",
  local: ".opencode/weave-opencode.jsonc",
};

/**
 * Canonical migration destination directory names, keyed by scope.
 * Migration ALWAYS writes to these paths — --install-dir is ignored.
 */
export const CANONICAL_WEAVE_DIR: Record<MigrationScope, string> = {
  global: ".weave",
  local: ".weave",
};

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

/**
 * Build a MigrationPlan for the given scope.
 *
 * Resolves source and destination paths relative to the scope root
 * (home directory for global, cwd for local).
 *
 * @param scope - Migration scope: "global" or "local"
 * @param fs - FileSystem abstraction for home/cwd resolution
 * @param skippedWarningCount - Pre-computed warning count for preflight display (default 0)
 */
export function buildMigrationPlan(
  scope: MigrationScope,
  fs: FileSystem,
  skippedWarningCount = 0,
): MigrationPlan {
  const scopeRoot = scope === "global" ? fs.home() : fs.cwd();
  const sourcePath = resolve(scopeRoot, LEGACY_SOURCE_RELATIVE[scope]);
  const destinationDir = resolve(scopeRoot, CANONICAL_WEAVE_DIR[scope]);
  const destinationPath = resolve(destinationDir, "config.weave");
  return {
    scope,
    sourcePath,
    destinationDir,
    destinationPath,
    skippedWarningCount,
  };
}

/**
 * Check whether a legacy weave-opencode.jsonc file exists for the given scope.
 * Returns the source path when found, undefined when absent, or an error when
 * the existence check itself fails (e.g. permission denied). Callers must
 * handle the error case and stop the migration flow rather than proceeding as
 * if the source were absent.
 */
export function detectLegacySource(
  scope: MigrationScope,
  fs: FileSystem,
): ResultAsync<string | undefined, { message: string }> {
  const scopeRoot = scope === "global" ? fs.home() : fs.cwd();
  const sourcePath = resolve(scopeRoot, LEGACY_SOURCE_RELATIVE[scope]);
  return fs
    .exists(sourcePath)
    .mapErr((error) => ({
      message: `Failed to check legacy source at ${sourcePath}: ${describeFileSystemError(error)}`,
    }))
    .map((exists) => (exists ? sourcePath : undefined));
}
