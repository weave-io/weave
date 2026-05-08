import { homedir } from "node:os";
import type { WeaveConfig } from "@weave/core";
import { parseConfig } from "@weave/core";
import { err, ok, ResultAsync } from "neverthrow";
import type { ConfigLoadError } from "./errors.js";
import { logger } from "./logger.js";
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
// discoverAndParse
// ---------------------------------------------------------------------------

/**
 * Discover and parse user config files for the global and project scopes.
 *
 * Checks two locations:
 * 1. `~/.weave/config.weave`   (global scope)
 * 2. `<projectRoot>/.weave/config.weave`  (project scope)
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
  const home = process.env.HOME ?? homedir();
  const root = projectRoot ?? process.cwd();

  const scopes: ConfigScope[] = [
    { kind: "global", rootDir: `${home}/.weave` },
    { kind: "project", rootDir: `${root}/.weave` },
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
