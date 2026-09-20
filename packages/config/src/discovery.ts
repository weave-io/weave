import { homedir } from "node:os";
import type { WeaveConfig } from "@weaveio/weave-core";
import { parseConfig } from "@weaveio/weave-core";
import { err, ok, ResultAsync } from "neverthrow";
import type { ConfigLoadError } from "./errors.js";
import { logger } from "./logger.js";
import { normalizePath } from "./normalize-path.js";
import type { ConfigScope } from "./types.js";

const log = logger.child({ module: "discovery" });

// ---------------------------------------------------------------------------
// FileReader abstraction
// ---------------------------------------------------------------------------

/**
 * Minimal file I/O interface used by `discoverAndParse`.
 *
 * Injecting this interface allows tests to provide mock implementations
 * without touching the real filesystem, as required by AGENTS.md.
 */
export interface FileReader {
  /** Returns `true` if the file at `path` exists and is readable. */
  exists(path: string): Promise<boolean>;
  /** Reads the file at `path` and returns its text content. */
  read(path: string): ResultAsync<string, ConfigLoadError>;
}

/**
 * Default `FileReader` implementation backed by `Bun.file()`.
 */
export const bunFileReader: FileReader = {
  exists: (path) => Bun.file(path).exists(),
  read: (path) =>
    ResultAsync.fromPromise(
      Bun.file(path).text(),
      (cause): ConfigLoadError => ({ type: "FileReadError", path, cause }),
    ),
};

// ---------------------------------------------------------------------------
// DiscoveredConfig
// ---------------------------------------------------------------------------

/**
 * A parsed config contribution paired with its origin scope.
 *
 * Returned by `discoverAndParse` for each config file that was found and
 * successfully parsed. Consumers use the `scope` to resolve prompt-file
 * paths and to understand merge priority.
 */
export type DiscoveredConfig = {
  /** The parsed and validated configuration from this file. */
  config: WeaveConfig;
  /** The scope (origin and root directory) of this config file. */
  scope: ConfigScope;
};

// ---------------------------------------------------------------------------
// Global scope root
// ---------------------------------------------------------------------------

/**
 * Environment variable that redirects the global config scope away from the
 * invoking user's home directory. See `discoverAndParse` for the rationale.
 */
export const GLOBAL_CONFIG_DIR_ENV = "WEAVE_GLOBAL_CONFIG_DIR";

/**
 * Resolves the directory that holds the global `config.weave`.
 *
 * `WEAVE_GLOBAL_CONFIG_DIR` wins when set to a non-empty value; otherwise the
 * global scope lives at `~/.weave` as usual.
 */
export function globalConfigDir(): string {
  const override = process.env[GLOBAL_CONFIG_DIR_ENV];
  if (override !== undefined && override.trim() !== "") {
    return normalizePath(override);
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return normalizePath(`${home}/.weave`);
}

// ---------------------------------------------------------------------------
// discoverAndParse
// ---------------------------------------------------------------------------

/**
 * Discover and parse user config files for the global and project scopes.
 *
 * Checks two locations:
 * 1. `~/.weave/config.weave`   (global scope)
 * 2. `<projectRoot>/.weave/config.weave`  (project scope)
 *
 * The global scope root can be redirected with the `WEAVE_GLOBAL_CONFIG_DIR`
 * environment variable. This exists so that a process which must not inherit
 * the invoking user's personal configuration — a CI job, a container, a
 * sandboxed harness run, or the test suite — can point the global layer at a
 * known directory instead. Pointing it at a directory with no `config.weave`
 * disables the global layer entirely, leaving builtins plus project config.
 *
 * Missing files are silently skipped — they are not treated as errors.
 * The returned array preserves scope order: global first, then project.
 *
 * Errors from both scopes are aggregated into a single `ConfigLoadError[]`
 * and returned together so callers receive a complete picture.
 *
 * @param projectRoot - Absolute path to the project root directory. Defaults
 *   to `process.cwd()`. The config file is expected at
 *   `<projectRoot>/.weave/config.weave`.
 * @param fileReader - Optional I/O implementation. Defaults to `bunFileReader`.
 *   Pass a mock to test without touching the filesystem.
 *
 * @returns `ok(DiscoveredConfig[])` with 0–2 entries, or
 *          `err(ConfigLoadError[])` if any found file could not be read or parsed.
 */
export function discoverAndParse(
  projectRoot?: string,
  fileReader: FileReader = bunFileReader,
): ResultAsync<DiscoveredConfig[], ConfigLoadError[]> {
  const root = projectRoot ?? process.cwd();

  const scopes: ConfigScope[] = [
    { kind: "global", rootDir: globalConfigDir() },
    { kind: "project", rootDir: normalizePath(`${root}/.weave`) },
  ];

  return ResultAsync.fromPromise(
    discoverAll(scopes, fileReader),
    (cause): ConfigLoadError[] => [{ type: "FileReadError", path: "", cause }],
  ).andThen((result) => result);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function discoverAll(
  scopes: ConfigScope[],
  fileReader: FileReader,
): Promise<import("neverthrow").Result<DiscoveredConfig[], ConfigLoadError[]>> {
  const discovered: DiscoveredConfig[] = [];
  const errors: ConfigLoadError[] = [];

  for (const scope of scopes) {
    const configPath = `${scope.rootDir}/config.weave`;

    log.debug({ path: configPath, scope: scope.kind }, "Checking config file");

    const exists = await fileReader.exists(configPath);
    if (!exists) continue;

    log.debug({ path: configPath, scope: scope.kind }, "Config file found");

    const readResult = await fileReader.read(configPath);
    if (readResult.isErr()) {
      errors.push(readResult.error);
      continue;
    }

    const parseResult = parseConfig(readResult.value);
    if (parseResult.isErr()) {
      errors.push({
        type: "ParseError",
        path: configPath,
        errors: parseResult.error,
      });
      continue;
    }

    discovered.push({ config: parseResult.value, scope });
  }

  if (errors.length > 0) return err(errors);
  return ok(discovered);
}
