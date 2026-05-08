import { resolve } from "node:path";
import { errAsync, type ResultAsync } from "neverthrow";
import { getBuiltinConfig } from "./builtins.js";
import {
  bunFileReader,
  discoverAndParse,
  type FileReader,
} from "./discovery.js";
import type { ConfigLoadError } from "./errors.js";
import { logger } from "./logger.js";
import { mergeConfigs } from "./merge.js";
import { resolvePromptPaths } from "./resolve.js";
import type { ConfigScope } from "./types.js";

const log = logger.child({ module: "loader" });

/**
 * The absolute path to the `packages/config` directory, used to resolve
 * builtin prompt files at runtime.
 *
 * `import.meta.dir` is the directory of this source file (`packages/config/src/`).
 * We resolve one level up to reach `packages/config/` where `prompts/` lives.
 */
const BUILTIN_ROOT_DIR = resolve(import.meta.dir, "..");

/**
 * Load the final merged `WeaveConfig` for a project.
 *
 * Orchestrates the full config pipeline in five steps:
 *
 * 1. **Builtins**: Call `getBuiltinConfig()` to get the 8 built-in agent
 *    defaults. On error, returns a `BuiltinParseError` (indicates a code bug).
 *
 * 2. **Discover**: Call `discoverAndParse(projectRoot)` to find and parse
 *    `~/.weave/config.weave` (global) and `<projectRoot>/.weave/config.weave`
 *    (project). Missing files are silently skipped.
 *
 * 3. **Resolve paths**: Call `resolvePromptPaths()` on each layer so that
 *    all `prompt_file` values become absolute paths before merging.
 *    - Builtins use `BUILTIN_ROOT_DIR` (this package's directory).
 *    - Each discovered config uses its own `scope.rootDir`.
 *
 * 4. **Merge**: Fold all layers left to right:
 *    `mergeConfigs(resolvedBuiltins, ...resolvedDiscovered)`
 *    (builtins first, then global, then project — discovery preserves order).
 *
 * 5. **Return**: Return `ok(mergedConfig)`.
 *
 * @param projectRoot - Absolute path to the project root directory. Defaults
 *   to `process.cwd()`. The project config file is expected at
 *   `<projectRoot>/.weave/config.weave`.
 * @param fileReader - Optional I/O implementation. Defaults to `bunFileReader`.
 *   Pass a mock in tests to avoid real filesystem reads.
 *
 * @returns `ok(WeaveConfig)` with the fully-merged config, or
 *          `err(ConfigLoadError[])` if any step fails.
 */
export function loadConfig(
  projectRoot?: string,
  fileReader: FileReader = bunFileReader,
): ResultAsync<import("@weave/core").WeaveConfig, ConfigLoadError[]> {
  // Step 1: Builtins
  const builtinResult = getBuiltinConfig();
  if (builtinResult.isErr()) {
    return errAsync<import("@weave/core").WeaveConfig, ConfigLoadError[]>([
      { type: "BuiltinParseError", errors: builtinResult.error },
    ]);
  }

  const builtinConfig = builtinResult.value;

  // Step 2–5: Discover, resolve, merge
  return discoverAndParse(projectRoot, fileReader).map((discovered) => {
    // Step 3: Resolve prompt paths for each layer
    const builtinScope: ConfigScope = {
      kind: "builtin",
      rootDir: BUILTIN_ROOT_DIR,
    };
    const resolvedBuiltins = resolvePromptPaths(builtinConfig, builtinScope);

    const resolvedDiscovered = discovered.map(({ config, scope }) =>
      resolvePromptPaths(config, scope),
    );

    // Step 4: Merge all layers
    const merged = mergeConfigs(resolvedBuiltins, ...resolvedDiscovered);

    const agentCount = Object.keys(merged.agents).length;
    log.debug({ agentCount }, "Merged config");
    log.info("Config loaded successfully");

    return merged;
  });
}
